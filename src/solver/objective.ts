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
 *
 * Pure and headless. Millimetres throughout.
 */

import { EPSILON } from '../domain/geometry';
import { parseStockInstanceId } from '../domain/instances';
import type { Part, Result, Stock } from '../domain/types';
import type { PackResult } from './guillotine/pack';

export interface SolutionScore {
  /** Total area of unplaced part instances in mm². Lower is better. */
  unplacedArea: number;
  /** Total full area (width * height) of all used stock sheets in mm². Lower is better. */
  usedStockArea: number;
  /** Area of the single largest free rectangle across all used sheets in mm². Higher is better. */
  maxFreeRectArea: number;
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

  // 3. Maximize single largest free rectangle area (higher is better -> b - a)
  const freeRectDiff = b.maxFreeRectArea - a.maxFreeRectArea;
  if (Math.abs(freeRectDiff) > EPSILON) return freeRectDiff;

  return 0;
}

/**
 * Returns true if `candidate` is strictly better than `best`.
 */
export function isBetterScore(candidate: SolutionScore, best: SolutionScore): boolean {
  return compareScores(candidate, best) < 0;
}

/**
 * Score a per-material subproblem `PackResult`.
 */
export function scorePackResult(packResult: PackResult): SolutionScore {
  let unplacedArea = 0;
  for (const instance of packResult.unplaced) {
    unplacedArea += instance.part.width * instance.part.height;
  }

  let usedStockArea = 0;
  let maxFreeRectArea = 0;

  for (const sheet of packResult.sheets) {
    usedStockArea += sheet.sheetArea;
    if (sheet.maxFreeRectArea > maxFreeRectArea) {
      maxFreeRectArea = sheet.maxFreeRectArea;
    }
  }

  return { unplacedArea, usedStockArea, maxFreeRectArea };
}

/**
 * Score a overall domain `Result` given the original parts and stock definitions.
 */
export function scoreResult(
  result: Result,
  parts: readonly Part[],
  stock: readonly Stock[],
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
      unplacedArea += unplaced.qty * part.width * part.height;
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

  // Domain Result does not track free rects, so maxFreeRectArea defaults to 0
  return { unplacedArea, usedStockArea, maxFreeRectArea: 0 };
}
