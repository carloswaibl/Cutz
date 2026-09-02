/**
 * The worker entry point. Deliberately the thinnest thing that can be written:
 * every decision - request ids, cancellation, stale replies, the fallback -
 * lives in `solveClient.ts`, which is testable in plain Node. This shell is the
 * only part of the async solve path with no test behind it, and that is the
 * reason it is ten lines.
 *
 * Instantiated by `solveClient.ts` as a module worker via Vite's native
 * `new Worker(new URL(...), { type: 'module' })`, which is what keeps
 * `CLAUDE.md` constraint 6 (no new runtime dependencies) intact while relaxing
 * constraint 4 - see `docs/plan-m7.md` §7 decision 8.
 */

import {
  runSolveRequest,
  type SolveRequestMessage,
  type SolveResponseMessage,
} from './solveProtocol';

/**
 * The two members of `DedicatedWorkerGlobalScope` this file uses.
 *
 * `tsconfig.app.json` sets `lib: ["ES2022", "DOM", "DOM.Iterable"]`, and adding
 * `"WebWorker"` alongside `"DOM"` collides on dozens of shared globals. So the
 * scope is narrowed structurally here rather than project-wide. Under the DOM
 * lib, `self` is typed as a `Window`, whose `postMessage` has a different
 * signature entirely - hence the cast rather than a plain call.
 */
interface SolveWorkerScope {
  onmessage: ((event: { data: SolveRequestMessage }) => void) | null;
  postMessage(message: SolveResponseMessage): void;
}

const scope = self as unknown as SolveWorkerScope;

scope.onmessage = (event) => {
  scope.postMessage(runSolveRequest(event.data));
};
