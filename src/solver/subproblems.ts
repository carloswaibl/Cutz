/**
 * The per-material driver every engine runs inside.
 *
 * Parts are grouped by material into fully independent subproblems - mixing two
 * materials on one sheet is meaningless - and each group is packed on its own.
 * None of that is guillotine-specific, and before M7 it was written out twice
 * (once in `packGuillotine`, once in `improveGuillotine`); a third copy would
 * have arrived with the nester. It lives here instead, so the engines differ
 * only in how they fill a sheet.
 *
 * Pure and headless. Millimetres throughout.
 */

import type { Part, Result, SolverConfig, Stock, UnplacedPart } from '../domain/types';
import { hasErrors, validateInputs } from '../domain/validate';
import { SolverInputError } from './errors';
import {
  expandPartInstances,
  expandStockInstances,
  type PartInstance,
  type StockInstance,
} from './instances';
import type { PackedResult } from './types';

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
 * How one engine fills the sheets of a single material.
 *
 * Deliberately not handed an `Rng`: the improvement pass creates one generator
 * for a whole solve and threads it across every material in turn, so material
 * order is part of the random stream and a seed reproduces a whole project
 * rather than each subproblem independently. A caller that needs randomness
 * closes over its own generator, which preserves that exactly.
 */
export type PackMaterial = (
  parts: readonly PartInstance[],
  stock: readonly StockInstance[],
) => PackedResult;

/**
 * Run one engine over every material and assemble the `Result`.
 *
 * `makePacker` is a factory rather than the packer itself, and is called
 * exactly once, *after* validation passes. That ordering matters: an engine
 * sets up its per-solve state there, and seeding a generator from a config the
 * validator is about to reject would throw a bare `Error` over the typed
 * `SolverInputError` the caller is owed.
 *
 * Throws `SolverInputError` if the input has issues of `error` severity.
 * Warnings - a part too large for any sheet, a material with no stock - are not
 * fatal: the solver runs and reports the consequence honestly in
 * `unplacedParts`, which is a more useful answer than a refusal.
 */
export function solveByMaterial(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
  makePacker: () => PackMaterial,
): Result {
  const issues = validateInputs(parts, stock, config);
  if (hasErrors(issues)) throw new SolverInputError(issues);

  const packOne = makePacker();
  const partGroups = groupByMaterial(parts);
  const stockGroups = groupByMaterial(stock);

  const result: Result = { layouts: [], unplacedParts: [], totalWastePct: 0 };
  const allUnplaced: PartInstance[] = [];
  let placedAreaTotal = 0;
  let usedSheetAreaTotal = 0;

  for (const [materialId, groupParts] of partGroups) {
    const packed = packOne(
      expandPartInstances(groupParts),
      expandStockInstances(stockGroups.get(materialId) ?? []),
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
