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

import type { Part, Result, SolverConfig, Stock, UnplacedPart } from '../../domain/types';
import { hasErrors, validateInputs } from '../../domain/validate';
import { SolverInputError } from '../errors';
import { expandPartInstances, expandStockInstances, type PartInstance } from '../instances';
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
 * Group parts by material, in the order the materials first appear.
 *
 * The key is `materialId` alone, not `(materialId, thickness)`. `Solver` is
 * never handed `Material[]`, and thickness is a property of the material, so
 * two materials of different thickness necessarily have different ids - the id
 * already encodes it.
 *
 * Groups are fully independent subproblems: a `Stock` entry belongs to exactly
 * one material, so no sheet is ever contested between two groups and the
 * instance ids stay globally unique without any coordination.
 */
export function groupByMaterial<T extends { materialId: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.materialId);
    if (group === undefined) groups.set(item.materialId, [item]);
    else group.push(item);
  }
  return groups;
}

/**
 * Roll a list of unplaced instances up into per-part shortfalls.
 *
 * Reported in the order the parts were declared rather than the order the packer
 * gave up on them, so the shortfall reads like the user's own part list.
 */
export function summariseUnplaced(
  unplaced: readonly PartInstance[],
  parts: readonly Part[],
): UnplacedPart[] {
  const counts = new Map<string, number>();
  for (const instance of unplaced) {
    counts.set(instance.part.id, (counts.get(instance.part.id) ?? 0) + 1);
  }

  const summary: UnplacedPart[] = [];
  for (const part of parts) {
    const qty = counts.get(part.id);
    if (qty !== undefined && qty > 0) summary.push({ partId: part.id, qty });
  }
  return summary;
}

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
  const issues = validateInputs(parts, stock, config);
  if (hasErrors(issues)) throw new SolverInputError(issues);

  const partGroups = groupByMaterial(parts);
  const stockGroups = groupByMaterial(stock);

  const result: Result = { layouts: [], unplacedParts: [], totalWastePct: 0 };
  const allUnplaced: PartInstance[] = [];
  let placedAreaTotal = 0;
  let usedSheetAreaTotal = 0;

  for (const [materialId, groupParts] of partGroups) {
    const packed = greedyPack(
      expandPartInstances(groupParts),
      expandStockInstances(stockGroups.get(materialId) ?? []),
      config,
      options,
    );

    for (const sheet of packed.sheets) {
      result.layouts.push(sheet.layout);
      // Accumulated per sheet, in the same order the layouts are emitted, so
      // this total is bit-identical to the one `checkResult` recomputes.
      placedAreaTotal += sheet.placedArea;
      usedSheetAreaTotal += sheet.sheetArea;
    }
    allUnplaced.push(...packed.unplaced);
  }

  result.unplacedParts = summariseUnplaced(allUnplaced, parts);
  // Nothing was cut, so nothing was wasted. Reporting 100% here would be worse
  // than useless - it is the number you would show a user who has not entered
  // any stock yet.
  result.totalWastePct = usedSheetAreaTotal > 0 ? 1 - placedAreaTotal / usedSheetAreaTotal : 0;
  return result;
}

export const GuillotineSolver: Solver = {
  solve(parts, stock, config) {
    return packGuillotine(parts, stock, config);
  },
};
