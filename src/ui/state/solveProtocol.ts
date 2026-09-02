/**
 * The wire format between the solve client and the worker, and the one function
 * that actually runs a solve.
 *
 * Its own module rather than part of `solveClient.ts` for a build reason:
 * `solveClient.ts` contains `new Worker(new URL('./solveWorker.ts', ...))`, and
 * a worker entry that imported the client would make Vite emit worker chunks
 * recursively. Both sides depend on this module and neither depends on the
 * other.
 *
 * Headless on purpose - no DOM, no React, no `Worker`. That is what lets the
 * main-thread fallback and the worker run *the same code*, which is the whole
 * basis of `docs/plan-m7.md` §3.6's promise that the two produce identical
 * layouts for the same seed.
 */

import type { Part, Result, SolverConfig, Stock } from '../../domain/types';
import { solve } from '../../solver/index';

export interface SolveRequestMessage {
  /** Monotonic, assigned by the client. Echoed back so stale replies can be dropped. */
  id: number;
  parts: Part[];
  stock: Stock[];
  config: SolverConfig;
}

export interface SolveResponseMessage {
  id: number;
  result: Result | null;
  /**
   * The failure as a plain string, never an `Error`.
   *
   * `SolverInputError` is a class carrying `issues`, and `structuredClone` -
   * which is what `postMessage` does - drops the prototype and would deliver a
   * shapeless object. Flattening to `err.message` here, in the one function
   * both transports call, is what keeps `solverError` the same `string | null`
   * whichever side produced it.
   */
  error: string | null;
}

/**
 * Run one solve and turn any throw into a message. Pure and total: it is the
 * only place either transport touches the solver.
 */
export function runSolveRequest(request: SolveRequestMessage): SolveResponseMessage {
  try {
    return {
      id: request.id,
      result: solve(request.parts, request.stock, request.config),
      error: null,
    };
  } catch (err: unknown) {
    return {
      id: request.id,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
