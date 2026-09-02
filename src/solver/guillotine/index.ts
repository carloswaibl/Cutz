/**
 * The guillotine solver: the v1 packing engine, behind the `Solver` interface.
 *
 * Nothing outside `solver/guillotine/` may import from inside it except the
 * default solver in `solver/index.ts`. That is the firewall that keeps v2's
 * free-form nesting droppable-in: the UI and the importers talk to `Solver`, and
 * this is one implementation of it, not the only one there will ever be.
 *
 * Pure and headless, deterministic, millimetres throughout.
 */

import type { Part, Result, SolverConfig, Stock } from '../../domain/types';
import { solveByMaterial } from '../subproblems';
import type { Solver } from '../types';
import { greedyPack, type PackOptions } from './pack';

export type { PackOptions } from './pack';
export { greedyPack } from './pack';

/**
 * The single combination the greedy pass uses.
 *
 * Selected by sweeping all knob combinations against the six *benchmark*
 * fixtures only. `mixed-stock` and `grain-locked-panels` are held out and had no
 * influence on this choice - they are the check on it, not an input to it.
 *
 * `longer-leftover` matters far more than the other two knobs, and it is the one
 * that reads as obviously right once seen: it runs the through-cut across the
 * *larger* leftover, so a placed part leaves behind one full-width strip rather
 * than two fragments. That is how a sheet actually gets broken down at a saw -
 * rip a strip the depth of a row, then crosscut parts out of it - and it is why
 * this combination reproduces the hand-checked row layouts in the fixture
 * descriptions exactly. Splitting across the shorter leftover instead scatters
 * each sheet into slivers and costs a whole extra sheet on `drawer-boxes`.
 *
 * The improvement pass samples the other combinations; the greedy pass never does.
 */
export const GUILLOTINE_DEFAULTS: PackOptions = {
  order: 'area-desc',
  fit: 'best-area',
  split: 'longer-leftover',
};

/**
 * Pack parts onto stock with the greedy guillotine engine.
 *
 * `options` exists so the improvement pass can drive the same packer with
 * different knobs. Callers who are not the improvement pass should leave it
 * alone.
 *
 * Throws `SolverInputError` if the input has issues of `error` severity.
 * Warnings - a part too large for any sheet, a material with no stock - are not
 * fatal: the solver runs and reports the consequence honestly in
 * `unplacedParts`, which is a more useful answer than a refusal.
 */
export function packGuillotine(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
  options: PackOptions = GUILLOTINE_DEFAULTS,
): Result {
  return solveByMaterial(
    parts,
    stock,
    config,
    () => (partInstances, stockInstances) =>
      greedyPack(partInstances, stockInstances, config, options),
  );
}

export const GuillotineSolver: Solver = {
  solve(parts, stock, config) {
    return packGuillotine(parts, stock, config);
  },
};
