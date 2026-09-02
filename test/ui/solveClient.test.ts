/**
 * `src/ui/state/solveClient.ts` - the headless half of M7 PR 7's async solve.
 *
 * No React renderer and no real `Worker`: the client takes its transport as an
 * injected factory precisely so the interesting behaviour - debouncing,
 * cancellation, stale-response dropping, falling back to the main thread - can
 * be driven in plain Node with `vi.useFakeTimers()`. Same convention as
 * `test/ui/projectStore.test.ts`; see `src/ui/state/solveClient.ts`'s header.
 *
 * The fake worker round-trips both the request and the response through
 * `structuredClone`, because that is what `postMessage` actually does. It is
 * the one behavioural difference between the two transports, so every test here
 * pays it rather than pretending the boundary is free.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result, SolverConfig } from '../../src/domain/types';
import { BOOKSHELF_PRESET } from '../../src/ui/state/presets';
import {
  createSolveClient,
  type SolveInput,
  type SolveState,
  type SolveWorkerFactory,
  type SolveWorkerHandlers,
  type SolveWorkerLike,
} from '../../src/ui/state/solveClient';
import { runSolveRequest, type SolveRequestMessage } from '../../src/ui/state/solveProtocol';

const DEBOUNCE_MS = 200;

interface FakeWorker extends SolveWorkerLike {
  readonly posted: SolveRequestMessage[];
  terminated: boolean;
  /** Answer the request at `index` (default: the last one) the way the real worker would. */
  reply(index?: number): void;
  /** The worker died - failed to start, or threw mid-solve. */
  fail(): void;
}

function fakeWorkers(): { factory: SolveWorkerFactory; created: FakeWorker[] } {
  const created: FakeWorker[] = [];
  const factory: SolveWorkerFactory = (handlers: SolveWorkerHandlers) => {
    const posted: SolveRequestMessage[] = [];
    const worker: FakeWorker = {
      posted,
      terminated: false,
      post(request) {
        posted.push(structuredClone(request));
      },
      terminate() {
        worker.terminated = true;
      },
      reply(index = posted.length - 1) {
        const request = posted[index];
        if (!request) throw new Error('nothing posted to reply to');
        handlers.onResponse(structuredClone(runSolveRequest(request)));
      },
      fail() {
        handlers.onFailure();
      },
    };
    created.push(worker);
    return worker;
  };
  return { factory, created };
}

function input(overrides: Partial<SolverConfig> = {}): SolveInput {
  return {
    parts: BOOKSHELF_PRESET.parts,
    stock: BOOKSHELF_PRESET.stock,
    config: { ...BOOKSHELF_PRESET.config, seed: 7, ...overrides },
  };
}

/** The client emits on subscribe, so index 0 of the log is always the initial state. */
function track(client: { subscribe: (l: (s: SolveState) => void) => () => void }): SolveState[] {
  const log: SolveState[] = [];
  client.subscribe((state) => log.push(state));
  return log;
}

function latest(log: SolveState[]): SolveState {
  const state = log[log.length - 1];
  if (!state) throw new Error('no state emitted');
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debouncing', () => {
  it('collapses a burst of edits into a single solve', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    track(client);

    // Typing a label dispatches UPDATE_PART per keystroke, which is what this
    // exists to absorb.
    for (let i = 0; i < 9; i++) {
      client.request(input());
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(created).toHaveLength(1);
    expect(created[0]?.posted).toHaveLength(1);
    client.dispose();
  });

  it('reports isSolving immediately, before the debounce fires', () => {
    const { factory } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    expect(latest(log).isSolving).toBe(false);
    client.request(input());
    expect(latest(log).isSolving).toBe(true);
    client.dispose();
  });
});

describe('results', () => {
  it('settles with the solved layout and clears isSolving', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    client.request(input());
    vi.advanceTimersByTime(DEBOUNCE_MS);
    created[0]?.reply();

    const state = latest(log);
    expect(state.isSolving).toBe(false);
    expect(state.solverError).toBeNull();
    expect(state.result?.layouts.length).toBeGreaterThan(0);
    client.dispose();
  });

  it('keeps the previous layout on screen while the next solve runs', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    client.request(input());
    vi.advanceTimersByTime(DEBOUNCE_MS);
    created[0]?.reply();
    const first = latest(log).result;
    expect(first).not.toBeNull();

    client.request(input({ seed: 8 }));
    // Mid-flight: still the old layout, but flagged as stale.
    expect(latest(log).result).toBe(first);
    expect(latest(log).isSolving).toBe(true);
    client.dispose();
  });

  it('turns a solver throw into solverError with no result', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    // A negative kerf is an `invalid-kerf` error, so `solve()` throws
    // `SolverInputError` - which is a class and does not survive
    // `structuredClone`. Flattening it to a string in `runSolveRequest` is what
    // makes this arrive intact.
    client.request(input({ kerf: -1 }));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    created[0]?.reply();

    const state = latest(log);
    expect(state.result).toBeNull();
    expect(state.isSolving).toBe(false);
    expect(state.solverError).toContain('Kerf is');
    client.dispose();
  });
});

describe('cancellation', () => {
  it('terminates a superseded solve and ignores its reply', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    client.request(input({ seed: 1 }));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    client.request(input({ seed: 2 }));
    vi.advanceTimersByTime(DEBOUNCE_MS);

    // The first worker is stopped rather than left burning a core, so the
    // second solve starts now instead of queueing behind it.
    expect(created).toHaveLength(2);
    expect(created[0]?.terminated).toBe(true);
    expect(created[1]?.terminated).toBe(false);

    created[0]?.reply();
    expect(latest(log).isSolving).toBe(true);
    expect(latest(log).result).toBeNull();

    created[1]?.reply();
    expect(latest(log).isSolving).toBe(false);
    expect(latest(log).result).not.toBeNull();
    client.dispose();
  });

  it('request(null) cancels a pending solve and clears', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    client.request(input());
    client.request(null);
    vi.advanceTimersByTime(DEBOUNCE_MS * 5);

    expect(created).toHaveLength(0);
    expect(latest(log)).toEqual({ result: null, solverError: null, isSolving: false });
    client.dispose();
  });

  /**
   * The shape `useSolve`'s reset effect relies on. A project switch clears
   * first and requests second, so the outgoing project's layout is never on
   * screen underneath the incoming project's parts - two projects made from the
   * same template share part and stock ids, so it would resolve and render
   * rather than being filtered out.
   */
  it('clearing then requesting leaves no trace of the previous layout', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    client.request(input({ seed: 1 }));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    created[0]?.reply();
    expect(latest(log).result).not.toBeNull();

    client.request(null);
    client.request(input({ seed: 2 }));
    expect(latest(log).result).toBeNull();
    expect(latest(log).isSolving).toBe(true);
    client.dispose();
  });

  it('request(null) mid-flight terminates the worker and ignores its reply', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    client.request(input());
    vi.advanceTimersByTime(DEBOUNCE_MS);
    client.request(null);

    expect(created[0]?.terminated).toBe(true);
    created[0]?.reply();
    expect(latest(log)).toEqual({ result: null, solverError: null, isSolving: false });
    client.dispose();
  });

  it('dispose stops the timer, the worker and the listeners', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    client.request(input());
    vi.advanceTimersByTime(DEBOUNCE_MS);
    const settled = log.length;
    client.dispose();
    created[0]?.reply();

    expect(created[0]?.terminated).toBe(true);
    expect(log).toHaveLength(settled);
  });
});

describe('main-thread fallback', () => {
  it('solves on the main thread when the worker cannot be constructed', () => {
    const client = createSolveClient({
      createWorker: () => {
        throw new Error('Worker is not defined');
      },
    });
    const log = track(client);

    client.request(input());
    vi.advanceTimersByTime(DEBOUNCE_MS);

    const state = latest(log);
    expect(state.isSolving).toBe(false);
    expect(state.solverError).toBeNull();
    expect(state.result?.layouts.length).toBeGreaterThan(0);
    client.dispose();
  });

  it('answers the orphaned request when a live worker dies, and stays fallen back', () => {
    const { factory, created } = fakeWorkers();
    const client = createSolveClient({ createWorker: factory });
    const log = track(client);

    client.request(input());
    vi.advanceTimersByTime(DEBOUNCE_MS);
    created[0]?.fail();

    // The request the dead worker was carrying still gets an answer.
    expect(latest(log).result?.layouts.length).toBeGreaterThan(0);
    expect(created[0]?.terminated).toBe(true);

    // And nothing tries to spawn another one - a browser that cannot run a
    // module worker will not learn to mid-session.
    client.request(input({ seed: 9 }));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(created).toHaveLength(1);
    expect(latest(log).result?.layouts.length).toBeGreaterThan(0);
    client.dispose();
  });

  /**
   * `docs/plan-m7.md` §5 PR 7's required test.
   *
   * Both transports call the same `runSolveRequest`, so the risk is not that
   * the engines differ - it is that the boundary mangles something on the way
   * through. The fake worker `structuredClone`s in both directions, so this
   * compares a round-tripped `Result` against one that never left the thread.
   */
  it('worker and main-thread fallback produce identical layouts for the same seed', () => {
    const { factory, created } = fakeWorkers();
    const viaWorker = createSolveClient({ createWorker: factory });
    const workerLog = track(viaWorker);
    viaWorker.request(input());
    vi.advanceTimersByTime(DEBOUNCE_MS);
    created[0]?.reply();

    const viaFallback = createSolveClient({
      createWorker: () => {
        throw new Error('no worker here');
      },
    });
    const fallbackLog = track(viaFallback);
    viaFallback.request(input());
    vi.advanceTimersByTime(DEBOUNCE_MS);

    const fromWorker = latest(workerLog).result as Result;
    const fromFallback = latest(fallbackLog).result as Result;
    expect(fromWorker.layouts.length).toBeGreaterThan(0);
    expect(fromWorker).toEqual(fromFallback);

    viaWorker.dispose();
    viaFallback.dispose();
  });
});
