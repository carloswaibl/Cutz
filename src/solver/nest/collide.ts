/**
 * Sheet occupancy, and the word-shifted collision test the placement scan runs
 * millions of times.
 *
 * A sheet is one bitmask of what is already taken. Testing a candidate is
 * shifting its mask into the sheet's word alignment and AND-ing row by row,
 * bailing on the first word that overlaps. Everything here is written for that
 * inner loop: no allocation, no polygon arithmetic, and a per-row summary that
 * lets the empty parts of a sheet be skipped rather than scanned.
 *
 * Bit order matches `raster.ts`: bit `k` of word `w` is column `32w + k`,
 * least-significant first, so shifting a word left moves the shape right.
 *
 * Pure and headless. Cells throughout - no millimetres reach this file.
 */

import type { Mask } from './raster';

/**
 * What a sheet already holds.
 *
 * `firstWord`/`lastWord` bound the occupied words of each row, or hold `-1` and
 * `-2` for an untouched row. Early parts land on empty sheets and later ones
 * scan past long stretches of empty rows, so this summary - not the word AND
 * itself - is what keeps the scan affordable.
 */
export interface Occupancy {
  cols: number;
  rows: number;
  stride: number;
  bits: Uint32Array;
  firstWord: Int32Array;
  lastWord: Int32Array;
  /**
   * `nextOccupied[r]` is the lowest occupied row at or after `r`, or `rows` when
   * there is none. One extra entry so `nextOccupied[rows]` is always valid.
   *
   * This is what makes the placement scan affordable. Without it a collision
   * test walks every row of the candidate's mask - hundreds of them for a shelf
   * side - even when the sheet beneath is entirely empty. With it the walk
   * visits only the rows that could possibly collide, so the overwhelmingly
   * common outcomes (nothing there, or the very first occupied row blocks it)
   * both cost about one iteration.
   */
  nextOccupied: Int32Array;
}

export function createOccupancy(cols: number, rows: number): Occupancy {
  const safeCols = Math.max(0, cols);
  const safeRows = Math.max(0, rows);
  const stride = Math.max(1, Math.ceil(safeCols / 32));
  return {
    cols: safeCols,
    rows: safeRows,
    stride,
    bits: new Uint32Array(stride * safeRows),
    firstWord: new Int32Array(safeRows).fill(-1),
    lastWord: new Int32Array(safeRows).fill(-2),
    nextOccupied: new Int32Array(safeRows + 1).fill(safeRows),
  };
}

/**
 * The last row holding anything, or `-1` on an untouched sheet.
 *
 * Everything below it is a full-width band of clear material - the offcut a
 * woodworker actually keeps off a nested sheet, and the only rectangle a raster
 * nester can honestly claim to have left behind.
 */
export function lastOccupiedRow(occupancy: Occupancy): number {
  for (let row = occupancy.rows - 1; row >= 0; row -= 1) {
    const first = occupancy.firstWord[row];
    if (first !== undefined && first >= 0) return row;
  }
  return -1;
}

/**
 * Rebuild the empty-row index. Called once per placement, never per candidate
 * position - it is O(rows) against a scan that is O(rows · cols).
 */
function reindex(occupancy: Occupancy): void {
  let next = occupancy.rows;
  occupancy.nextOccupied[occupancy.rows] = next;
  for (let row = occupancy.rows - 1; row >= 0; row -= 1) {
    const first = occupancy.firstWord[row];
    if (first !== undefined && first >= 0) next = row;
    occupancy.nextOccupied[row] = next;
  }
}

/**
 * True when `mask`, laid down with its top-left cell at `(col, row)`, overlaps
 * anything already on the sheet.
 *
 * `col` and `row` may be negative and the mask may run off any edge: the parts
 * that fall outside are ignored rather than treated as blocked. That is
 * deliberate and matches the guillotine rule - a sheet edge is not a cut, so no
 * kerf is owed there, and it is the dilated halo that hangs over the edge, never
 * the part itself. Containment of the part proper is a separate, exact test in
 * `place.ts`.
 */
export function collides(occupancy: Occupancy, mask: Mask, col: number, row: number): boolean {
  const shift = ((col % 32) + 32) % 32;
  const wordOffset = Math.floor(col / 32);

  const spanEnd = Math.min(occupancy.rows, row + mask.rows);
  let sheetRow = occupancy.nextOccupied[Math.max(0, row)] ?? occupancy.rows;

  for (; sheetRow < spanEnd; sheetRow = occupancy.nextOccupied[sheetRow + 1] ?? occupancy.rows) {
    const maskRow = sheetRow - row;

    const first = occupancy.firstWord[sheetRow];
    const last = occupancy.lastWord[sheetRow];
    if (first === undefined || last === undefined || first < 0) continue;

    const maskBase = maskRow * mask.stride;
    const sheetBase = sheetRow * occupancy.stride;

    for (let w = 0; w < mask.stride; w += 1) {
      const maskWord = mask.bits[maskBase + w];
      if (maskWord === undefined || maskWord === 0) continue;

      const low = wordOffset + w;
      if (low > last + 1 || low + 1 < first) continue;

      if (shift === 0) {
        if (low >= 0 && low < occupancy.stride) {
          const sheetWord = occupancy.bits[sheetBase + low];
          if (sheetWord !== undefined && (sheetWord & maskWord) !== 0) return true;
        }
        continue;
      }

      const lowPart = (maskWord << shift) >>> 0;
      if (lowPart !== 0 && low >= 0 && low < occupancy.stride) {
        const sheetWord = occupancy.bits[sheetBase + low];
        if (sheetWord !== undefined && (sheetWord & lowPart) !== 0) return true;
      }
      const highPart = maskWord >>> (32 - shift);
      if (highPart !== 0 && low + 1 >= 0 && low + 1 < occupancy.stride) {
        const sheetWord = occupancy.bits[sheetBase + low + 1];
        if (sheetWord !== undefined && (sheetWord & highPart) !== 0) return true;
      }
    }
  }
  return false;
}

/**
 * OR `mask` into the sheet at `(col, row)`, and update the row summaries.
 *
 * The *exact* mask is what gets written, never the dilated one. Charging the
 * kerf to the candidate being tested rather than to the parts already down is
 * what makes the result order-independent: whichever of two parts is placed
 * first, the gap between them comes out the same.
 */
export function orInto(occupancy: Occupancy, mask: Mask, col: number, row: number): void {
  const shift = ((col % 32) + 32) % 32;
  const wordOffset = Math.floor(col / 32);

  for (let maskRow = 0; maskRow < mask.rows; maskRow += 1) {
    const sheetRow = row + maskRow;
    if (sheetRow < 0 || sheetRow >= occupancy.rows) continue;

    const maskBase = maskRow * mask.stride;
    const sheetBase = sheetRow * occupancy.stride;

    for (let w = 0; w < mask.stride; w += 1) {
      const maskWord = mask.bits[maskBase + w];
      if (maskWord === undefined || maskWord === 0) continue;

      const low = wordOffset + w;
      if (shift === 0) {
        write(occupancy, sheetBase, sheetRow, low, maskWord);
        continue;
      }
      write(occupancy, sheetBase, sheetRow, low, (maskWord << shift) >>> 0);
      write(occupancy, sheetBase, sheetRow, low + 1, maskWord >>> (32 - shift));
    }
  }

  reindex(occupancy);
}

function write(
  occupancy: Occupancy,
  sheetBase: number,
  sheetRow: number,
  wordIndex: number,
  value: number,
): void {
  if (value === 0 || wordIndex < 0 || wordIndex >= occupancy.stride) return;

  // Keep the invariant that bits past `cols` in the final word stay zero: the
  // collision test clips the right-hand edge by relying on it rather than by
  // masking on every comparison. A legal placement cannot reach here anyway -
  // its part fits inside the usable area - but a wrapped bit would read as a
  // phantom part at column 0 of the same row, which is not a bug anyone would
  // find twice.
  const spare = occupancy.cols % 32;
  const clipped =
    wordIndex === occupancy.stride - 1 && spare !== 0 ? value & ((1 << spare) - 1) : value;
  if (clipped === 0) return;

  const current = occupancy.bits[sheetBase + wordIndex];
  if (current === undefined) return;
  occupancy.bits[sheetBase + wordIndex] = (current | clipped) >>> 0;

  const first = occupancy.firstWord[sheetRow];
  const last = occupancy.lastWord[sheetRow];
  if (first === undefined || last === undefined) return;
  if (first < 0 || wordIndex < first) occupancy.firstWord[sheetRow] = wordIndex;
  if (wordIndex > last) occupancy.lastWord[sheetRow] = wordIndex;
}
