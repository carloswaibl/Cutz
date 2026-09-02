/**
 * The React wrapper around `solveClient.ts`. Thin by design - see that module's
 * header. It owns one client for the component's life, feeds it the inputs, and
 * mirrors its state into React.
 *
 * Replaces the synchronous `solve()` call that used to sit in a `useMemo` in
 * `useCutListState.ts`. Everything downstream reads the same `result` and
 * `solverError` it always did; the only addition is `isSolving`, which exists
 * because a result that arrives seconds later needs the diagram to say so.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Part, SolverConfig, Stock } from '../../domain/types';
import { createSolveClient, type SolveState } from './solveClient';

export function useSolve(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
  /**
   * Changes when a whole project is loaded rather than edited. See
   * `AppState.projectGeneration` for why keeping the previous layout is right
   * for one and wrong for the other.
   */
  resetKey: number,
): SolveState {
  // One client, one worker, for the life of the mount. The client takes no
  // arguments here on purpose: its injectable transport exists for
  // `test/ui/solveClient.test.ts`, which drives the client directly rather than
  // through React, so threading it through the hook would be a parameter with
  // no caller and a dependency this memo would have to defend.
  const client = useMemo(() => createSolveClient(), []);

  const [state, setState] = useState<SolveState>({
    result: null,
    solverError: null,
    isSolving: false,
  });

  useEffect(() => client.subscribe(setState), [client]);

  useEffect(
    () => () => {
      client.dispose();
    },
    [client],
  );

  // Drop the outgoing project's layout before the incoming one is requested.
  //
  // Declared *above* the request effect on purpose: React runs a component's
  // effects in declaration order within one commit, and a project load changes
  // `resetKey` and the inputs together, so this clears and the next one starts
  // a fresh solve. Comparing against the last seen key rather than tracking
  // "have I mounted" makes the mount fall out for free - there is nothing to
  // clear then, and the extra emit would only be noise.
  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    client.request(null);
  }, [client, resetKey]);

  useEffect(() => {
    // Nothing to solve is not an error and not a pending state - it is the
    // empty project, and it clears rather than spinning. Same early return the
    // old `useMemo` made.
    if (parts.length === 0 || stock.length === 0) {
      client.request(null);
      return;
    }
    client.request({ parts, stock, config });
  }, [client, parts, stock, config]);

  return state;
}
