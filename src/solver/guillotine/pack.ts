/**
 * The greedy multi-sheet guillotine packer.
 *
 * One material at a time - the caller has already split the problem into
 * independent per-material subproblems, and mixing materials on a sheet is
 * meaningless anyway. Sheets are opened one at a time, largest usable area
 * first, and a sheet is only opened when a part fits nowhere on the ones already
 * open. Parts that fit nowhere at all end up in the shortfall.
 *
 * **There is no randomness here.** Every tie breaks on an index, so the same
 * inputs and options always produce byte-identical output. All randomness in the
 * solver lives in the improvement pass and comes from the seeded PRNG - a
 * layout a user printed and carried to the saw has to come back identical when
 * they reopen the project.
 *
 * Pure and headless. Millimetres throughout.
 */

import { area, isEmpty, usableArea } from '../../domain/geometry';
import type { Layout, Placement, SolverConfig } from '../../domain/types';
import type { PartInstance, StockInstance } from '../instances';
import {
  bestFit,
  type FitHeuristic,
  FreeRectList,
  orderParts,
  orientations,
  type PartOrder,
  type SplitRule,
} from './freeRects';

export interface PackOptions {
  order: PartOrder;
  fit: FitHeuristic;
  split: SplitRule;
}

export interface SheetLayout {
  layout: Layout;
  /** Sum of the placed footprints on this sheet, mm². */
  placedArea: number;
  /** Full `width * height` of the sheet, mm². Not the usable area - see below. */
  sheetArea: number;
}

export interface PackResult {
  sheets: SheetLayout[];
  /** Instances no sheet could hold, in the order they were offered. */
  unplaced: PartInstance[];
}

/**
 * The smallest footprint dimensions any of these instances could need.
 *
 * Used to prune free rectangles that no remaining part can use, in either
 * orientation. Computed once per sheet and then held fixed: as parts get placed
 * the true minimum can only grow, so a bound taken at the start of the pass is
 * conservative and can never prune a rectangle something still needs.
 */
function smallestFootprint(instances: readonly PartInstance[]): { width: number; height: number } {
  let width = Number.POSITIVE_INFINITY;
  let height = Number.POSITIVE_INFINITY;
  for (const instance of instances) {
    for (const footprint of orientations(instance.part)) {
      width = Math.min(width, footprint.width);
      height = Math.min(height, footprint.height);
    }
  }
  return { width, height };
}

/**
 * Pack one material's parts onto one material's sheets.
 *
 * Sheets are sorted by usable area descending, which is the order they get
 * opened in. The sort is stable, so equal-sized sheets keep declaration order
 * and instance ids stay in ascending order within a stock entry.
 */
export function greedyPack(
  partInstances: readonly PartInstance[],
  stockInstances: readonly StockInstance[],
  config: SolverConfig,
  options: PackOptions,
): PackResult {
  const sheets: SheetLayout[] = [];
  let remaining = orderParts(partInstances, options.order);

  const bySize = [...stockInstances].sort(
    (a, b) =>
      area(usableArea(b.stock, config.edgeTrim)) - area(usableArea(a.stock, config.edgeTrim)),
  );

  for (const sheet of bySize) {
    if (remaining.length === 0) break;

    const usable = usableArea(sheet.stock, config.edgeTrim);
    // `validateInputs` reports this as a hard error before the packer ever runs,
    // so this is belt-and-braces: a sheet with no usable area holds nothing, and
    // packing into a negative-sized rectangle would be nonsense rather than a
    // worse layout.
    if (isEmpty(usable)) continue;

    const free = new FreeRectList(usable);
    const smallest = smallestFootprint(remaining);
    const placements: Placement[] = [];
    const leftover: PartInstance[] = [];
    let placedArea = 0;

    for (const instance of remaining) {
      const candidate = bestFit(instance.part, free.list(), options.fit);
      if (candidate === null) {
        // Not a dead end - a later sheet may be larger, or simply emptier.
        leftover.push(instance);
        continue;
      }

      const rect = free.list()[candidate.rectIndex];
      // `bestFit` only ever returns an index it read from this same list.
      if (rect === undefined)
        throw new Error('bestFit returned a free rectangle that is not there');

      placements.push({
        partId: instance.part.id,
        stockInstanceId: sheet.id,
        // The part goes in the top-left corner of the free rectangle it won.
        x: rect.x,
        y: rect.y,
        rotated: candidate.footprint.rotated,
      });
      // Multiplied in this order, and accumulated in placement order, so the
      // waste figure below is bit-identical to the one `checkResult` recomputes.
      placedArea += candidate.footprint.width * candidate.footprint.height;

      free.place(candidate.rectIndex, candidate.footprint, config.kerf, options.split);
      free.prune(smallest.width, smallest.height);
    }

    remaining = leftover;
    if (placements.length === 0) continue;

    // Waste is measured against the *full* sheet, not the usable area: the edge
    // trim is material the user bought and lost, so it is waste - it just could
    // never have held a part. Sheets that stayed shut are excluded entirely by
    // never being pushed here; owning ten sheets and using two is not 80% waste.
    const sheetArea = sheet.stock.width * sheet.stock.height;
    sheets.push({
      layout: { stockInstanceId: sheet.id, placements, wastePct: 1 - placedArea / sheetArea },
      placedArea,
      sheetArea,
    });
  }

  return { sheets, unplaced: remaining };
}
