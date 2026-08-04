/**
 * Stock instance identity.
 *
 * A `Stock` entry with `qty: 3` is three physical sheets, and a `Placement`
 * names exactly one of them. The id that names it is `${stockId}#${index}`,
 * index from 0, assigned in declaration order - deterministic and stable across
 * runs, which matters because a saved project must reproduce the same layout.
 *
 * The convention lives here rather than in the packer that mints the ids,
 * because the invariant checker has to read them back. One owner, one format.
 */

const SEPARATOR = '#';

/** Canonical form: `index` must be a non-negative integer. */
export function stockInstanceId(stockId: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`stock instance index must be a non-negative integer, got ${index}`);
  }
  return `${stockId}${SEPARATOR}${index}`;
}

export interface StockInstanceRef {
  stockId: string;
  index: number;
}

/**
 * Read an instance id back into its parts, or `null` if it is not one.
 *
 * Splits at the *last* separator so a stock id that itself contains one - a
 * user-supplied or imported id is not guaranteed to avoid it - still round
 * trips. Only the canonical spelling of the index is accepted, so `s1#007` is
 * rejected rather than silently read as instance 7 that no longer formats back
 * to itself.
 */
export function parseStockInstanceId(id: string): StockInstanceRef | null {
  const separator = id.lastIndexOf(SEPARATOR);
  // `<= 0` also rejects an empty stock id, which no real stock entry has.
  if (separator <= 0) return null;

  const suffix = id.slice(separator + 1);
  if (!/^(?:0|[1-9]\d*)$/.test(suffix)) return null;

  const index = Number(suffix);
  if (!Number.isSafeInteger(index)) return null;

  return { stockId: id.slice(0, separator), index };
}
