/**
 * Quantity expansion.
 *
 * The domain model says "four of this shelf" and "three of this sheet", but a
 * packer places individual objects: each shelf goes at its own coordinates and
 * each sheet gets its own layout. This module turns counts into instances.
 *
 * Both expansions run in declaration order, so instance identity is a pure
 * function of the input. That is not a detail - a saved project has to reopen to
 * the same layout, and the layout is described in terms of these instances.
 *
 * Pure and headless. No randomness.
 */

import { stockInstanceId } from '../domain/instances';
import type { Part, Stock } from '../domain/types';

export interface PartInstance {
  part: Part;
  /** Which unit of the part's `qty` this is, from 0. */
  index: number;
}

export interface StockInstance {
  stock: Stock;
  /** `${stock.id}#${index}` - the id a `Placement` and a `Layout` refer to. */
  id: string;
  index: number;
}

/**
 * One entry per unit of every part's `qty`.
 *
 * Instances of the same part share a `part` reference rather than copying it.
 * Nothing here mutates it, and the packer needs identity to group placements
 * back onto a single part id.
 */
export function expandPartInstances(parts: readonly Part[]): PartInstance[] {
  const instances: PartInstance[] = [];
  for (const part of parts) {
    for (let index = 0; index < part.qty; index += 1) {
      instances.push({ part, index });
    }
  }
  return instances;
}

/**
 * One entry per physical sheet.
 *
 * The id format is owned by `domain/instances.ts` rather than minted here: the
 * invariant checker has to read these ids back, and a format with two authors is
 * a format with two spellings.
 */
export function expandStockInstances(stock: readonly Stock[]): StockInstance[] {
  const instances: StockInstance[] = [];
  for (const sheet of stock) {
    for (let index = 0; index < sheet.qty; index += 1) {
      instances.push({ stock: sheet, id: stockInstanceId(sheet.id, index), index });
    }
  }
  return instances;
}
