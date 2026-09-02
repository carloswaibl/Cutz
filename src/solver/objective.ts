/**
 * Objective function for candidate layout evaluation.
 *
 * Compares candidate solver outputs lexicographically per `docs/plan-m1.md` §3.5:
 *
 * 1. **Minimize unplaced part area.** Failing to place a large panel is worse
 *    than failing to place a small one.
 * 2. **Minimize total area of used stock.** Total full area of used sheets (not
 *    sheet count: with mixed sheet sizes, consuming one half-sheet is better
 *    than one full sheet).
 * 3. **Maximize single largest free rectangle area across used sheets.** Pure
 *    tiebreaker that consolidates remaining leftover into one usable offcut.
 *    Only applies to an engine that has free rectangles at all.
 *
 * Engine-agnostic: it scores a `PackedResult` from `solver/types.ts` and knows
 * nothing about how the sheets were filled, which is what lets the guillotine
 * packer and the nester share one objective.
 *
 * Pure and headless. Millimetres throughout.
 */

import { EPSILON } from '../domain/geometry';
import { parseStockInstanceId } from '../domain/instances';
import { placedArea } from '../domain/polygon';
import type { Part, Result, SolverMode, Stock } from '../domain/types';
import type { PackedResult } from './types';

export interface SolutionScore {
  /** Total area of unplaced part instances in mm². Lower is better. */
  unplacedArea: number;
  /** Total full area (width * height) of all used stock sheets in mm². Lower is better. */
  usedStockArea: number;
  /**
   * Area of the single largest free rectangle across all used sheets in mm².
   * Higher is better.
   *
   * Optional: only a free-rectangle engine has one. Absent means this criterion
   * does not apply to the score, which is not the same as it scoring zero - see
   * `compareScores`.
   */
  maxFreeRectArea?: number;
}

/**
 * Compare two solution scores lexicographically.
 *
 * Returns:
 * - `< 0` if `a` is strictly better than `b`
 * - `> 0` if `b` is strictly better than `a`
 * - `0` if `a` and `b` are equivalent within numerical precision (`EPSILON`)
 */
export function compareScores(a: SolutionScore, b: SolutionScore): number {
  // 1. Minimize unplaced part area
  const unplacedDiff = a.unplacedArea - b.unplacedArea;
  if (Math.abs(unplacedDiff) > EPSILON) return unplacedDiff;

  // 2. Minimize total area of used stock
  const stockDiff = a.usedStockArea - b.usedStockArea;
  if (Math.abs(stockDiff) > EPSILON) return stockDiff;

  // 3. Maximize single largest free rectangle area (higher is better -> b - a).
  //
  // Skipped entirely when either side omits it. Treating an absent value as 0
  // would make a nested candidate - which has no free rectangles at all - lose
  // this tiebreak to any free-rectangle candidate, a comparison that means
  // nothing since the two engines are never asked to rank each other's work.
  if (a.maxFreeRectArea !== undefined && b.maxFreeRectArea !== undefined) {
    const freeRectDiff = b.maxFreeRectArea - a.maxFreeRectArea;
    if (Math.abs(freeRectDiff) > EPSILON) return freeRectDiff;
  }

  return 0;
}

/**
 * Returns true if `candidate` is strictly better than `best`.
 */
export function isBetterScore(candidate: SolutionScore, best: SolutionScore): boolean {
  return compareScores(candidate, best) < 0;
}

/**
 * Score one per-material subproblem, whichever engine packed it.
 *
 * `mode` decides how much sheet an unplaced part would have consumed, via the
 * single `placedArea` accessor the validator and the UI also use - a saw loses
 * the whole bounding box, a router only the outline (`docs/plan-m7.md` §7
 * decision 4). For a guillotine pack this is exactly `width * height`.
 */
export function scorePack(packed: PackedResult, mode: SolverMode): SolutionScore {
  let unplacedArea = 0;
  for (const instance of packed.unplaced) {
    unplacedArea += placedArea(instance.part, mode);
  }

  let usedStockArea = 0;
  // Left undefined unless some sheet actually reported one, so an engine with
  // no free-rectangle notion produces a score that skips criterion 3 rather
  // than one that claims a largest offcut of zero.
  let maxFreeRectArea: number | undefined;

  for (const sheet of packed.sheets) {
    usedStockArea += sheet.sheetArea;
    if (sheet.maxFreeRectArea !== undefined) {
      if (maxFreeRectArea === undefined || sheet.maxFreeRectArea > maxFreeRectArea) {
        maxFreeRectArea = sheet.maxFreeRectArea;
      }
    }
  }

  // Built two ways rather than assigning `undefined`: under
  // `exactOptionalPropertyTypes` an absent property and one holding `undefined`
  // are different things, and absent is the one that means "does not apply".
  return maxFreeRectArea === undefined
    ? { unplacedArea, usedStockArea }
    : { unplacedArea, usedStockArea, maxFreeRectArea };
}

/**
 * Score an overall domain `Result` given the original parts and stock definitions.
 *
 * A `Result` carries no free-rectangle information, so criterion 3 is simply
 * absent rather than reported as zero.
 */
export function scoreResult(
  result: Result,
  parts: readonly Part[],
  stock: readonly Stock[],
  mode: SolverMode,
): SolutionScore {
  const partsMap = new Map<string, Part>();
  for (const part of parts) {
    partsMap.set(part.id, part);
  }

  const stockMap = new Map<string, Stock>();
  for (const sheet of stock) {
    stockMap.set(sheet.id, sheet);
  }

  let unplacedArea = 0;
  for (const unplaced of result.unplacedParts) {
    const part = partsMap.get(unplaced.partId);
    if (part !== undefined) {
      unplacedArea += unplaced.qty * placedArea(part, mode);
    }
  }

  let usedStockArea = 0;
  for (const layout of result.layouts) {
    const ref = parseStockInstanceId(layout.stockInstanceId);
    if (ref !== null) {
      const s = stockMap.get(ref.stockId);
      if (s !== undefined) {
        usedStockArea += s.width * s.height;
      }
    }
  }

  return { unplacedArea, usedStockArea };
}
