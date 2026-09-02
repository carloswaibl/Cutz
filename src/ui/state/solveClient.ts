/**
 * Headless solve client: request ids, stale-response dropping, cancellation,
 * and the main-thread fallback. `useSolve.ts` is the thin React wrapper around
 * it - the same split `projectStore.ts`/`useProjectStorage.ts` uses, and for the
 * same reason: this is the logic worth testing, and testing it must not need a
 * renderer. `@testing-library/react` is deliberately not a dependency.
 *
 * Why any of this exists: `docs/plan-m7.md` §1 criterion 8. The nester measured
 * 2.8-7.4s per solve in PR 6, and until now `useCutListState` called `solve()`
 * synchronously inside a `useMemo` - seconds of frozen tab on the render path.
 */

import type { Part, Result, SolverConfig, Stock } from '../../domain/types';
import { createDebouncer } from './debounce';
import {
  runSolveRequest,
  type SolveRequestMessage,
  type SolveResponseMessage,
} from './solveProtocol';

/**
 * Coalesces a burst of edits into one solve.
 *
 * `PartTable` dispatches `UPDATE_PART` on every keystroke of a part label, so a
 * nine-character label was nine full solves. This debounces the *request*; the
 * engine's iteration budgets are untouched, so `docs/plan-m7.md` §3.6's "no
 * wall-clock early stopping" still holds and the same inputs and seed still give
 * the same layout. Shorter than autosave's 500ms because a guillotine solve is
 * ~20ms and should still feel immediate.
 */
const DEBOUNCE_MS = 200;

export interface SolveInput {
  parts: readonly Part[];
  stock: readonly Stock[];
  config: SolverConfig;
}

export interface SolveState {
  result: Result | null;
  solverError: string | null;
  /** True from the moment a request is made until its own response settles. */
  isSolving: boolean;
}

/** The two things the client does to a worker. See `createWorkerTransport`. */
export interface SolveWorkerLike {
  post(request: SolveRequestMessage): void;
  terminate(): void;
}

export interface SolveWorkerHandlers {
  onResponse(response: SolveResponseMessage): void;
  /** The worker itself failed - it never started, or it errored mid-solve. */
  onFailure(): void;
}

export type SolveWorkerFactory = (handlers: SolveWorkerHandlers) => SolveWorkerLike;

export interface SolveClient {
  /** `null` means there is nothing to solve; it cancels and clears. */
  request(input: SolveInput | null): void;
  /** Calls `listener` immediately with the current state, then on every change. */
  subscribe(listener: (state: SolveState) => void): () => void;
  dispose(): void;
}

export interface SolveClientOptions {
  /** Injected by tests. Defaults to a real module worker. */
  createWorker?: SolveWorkerFactory;
  debounceMs?: number;
}

/**
 * The real transport. The DOM `Worker` type is adapted to `SolveWorkerLike`
 * here, in one place, so tests never have to construct a `MessageEvent` and the
 * client never has to know what a `MessageEvent` is.
 */
function createWorkerTransport(handlers: SolveWorkerHandlers): SolveWorkerLike {
  const worker = new Worker(new URL('./solveWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<SolveResponseMessage>) => {
    handlers.onResponse(event.data);
  };
  // A module worker that the browser cannot start, or one that throws, is
  // reported here rather than detected by a timeout. A timeout would be the one
  // piece of wall-clock this milestone has been careful to keep out.
  worker.onerror = () => {
    handlers.onFailure();
  };
  worker.onmessageerror = () => {
    handlers.onFailure();
  };
  return {
    post: (request) => {
      worker.postMessage(request);
    },
    terminate: () => {
      worker.terminate();
    },
  };
}

const IDLE: SolveState = { result: null, solverError: null, isSolving: false };

export function createSolveClient(options: SolveClientOptions = {}): SolveClient {
  const createWorker = options.createWorker ?? createWorkerTransport;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  const listeners = new Set<(state: SolveState) => void>();
  let state: SolveState = IDLE;

  let nextId = 1;
  /** The only request whose response is still wanted. */
  let currentId = 0;
  let inFlight: SolveRequestMessage | null = null;
  let worker: SolveWorkerLike | null = null;
  /**
   * Flipped false by the first worker failure and never back.
   *
   * A browser that cannot run a module worker will not learn to mid-session, and
   * retrying per request would mean paying a failed construction on every
   * keystroke. One failure is enough to decide.
   */
  let workerUsable = true;

  function emit(next: SolveState) {
    state = next;
    for (const listener of listeners) listener(state);
  }

  /**
   * Stop the in-flight solve for real, rather than just ignoring its answer.
   *
   * A worker cannot be interrupted from the outside, so a superseded 7s nest
   * solve would otherwise keep a core busy and make the *next* request queue
   * behind it - the user waits two solves for one edit. Terminating bounds that
   * at one. The cost is a module parse on the respawn, paid only when a user
   * actually edits mid-solve.
   */
  function abortInFlight() {
    if (!inFlight) return;
    inFlight = null;
    worker?.terminate();
    worker = null;
  }

  function settle(response: SolveResponseMessage) {
    inFlight = null;
    emit({ result: response.result, solverError: response.error, isSolving: false });
  }

  function handleResponse(response: SolveResponseMessage) {
    // Stale: a newer request superseded this one while it was in flight.
    if (response.id !== currentId) return;
    settle(response);
  }

  function handleFailure() {
    workerUsable = false;
    const orphaned = inFlight;
    inFlight = null;
    worker?.terminate();
    worker = null;
    // The request the dead worker was carrying still deserves an answer, so it
    // is re-run on the main thread. Everything after it takes the same path.
    if (orphaned && orphaned.id === currentId) settle(runSolveRequest(orphaned));
  }

  function dispatch(input: SolveInput) {
    abortInFlight();
    const request: SolveRequestMessage = {
      id: nextId++,
      parts: [...input.parts],
      stock: [...input.stock],
      config: input.config,
    };
    currentId = request.id;

    if (workerUsable) {
      try {
        worker ??= createWorker({ onResponse: handleResponse, onFailure: handleFailure });
        inFlight = request;
        worker.post(request);
        return;
      } catch {
        workerUsable = false;
        worker = null;
        inFlight = null;
      }
    }
    settle(runSolveRequest(request));
  }

  const debouncer = createDebouncer<SolveInput>(debounceMs, dispatch);

  return {
    request(input) {
      if (input === null) {
        debouncer.cancel();
        abortInFlight();
        currentId = nextId++;
        emit(IDLE);
        return;
      }
      // `isSolving` rises here, before the debounce fires: whatever is on screen
      // is already stale at the moment the user edits, and saying so late would
      // leave the diagram silently wrong for the debounce window. `result` and
      // `solverError` are retained so the previous layout stays visible; the
      // response replaces both at once.
      if (!state.isSolving) emit({ ...state, isSolving: true });
      debouncer.schedule(input);
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      debouncer.cancel();
      abortInFlight();
      worker?.terminate();
      worker = null;
      listeners.clear();
    },
  };
}
