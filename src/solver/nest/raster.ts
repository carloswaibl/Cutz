/**
 * Turning a polygon into a bitmask, and growing that bitmask by a kerf.
 *
 * The nesting engine collides shapes on a grid rather than analytically. A
 * no-fit-polygon nester needs convex decomposition for concave outlines plus
 * degenerate-touching and float-robustness handling; a raster is robust on any
 * shape at any angle, trivially deterministic, and needs no dependency.
 * `docs/plan-m7.md` §7 decision 2.
 *
 * **Rasterisation is conservative: a cell is occupied if the polygon touches it
 * at all.** That is what makes the grid a quality knob rather than a correctness
 * one - every point of a shape lies inside some marked cell, so the separation
 * argument in `dilationOffsets` below holds regardless of resolution. A finer
 * grid packs tighter; it never packs *wronger*.
 *
 * Pure and headless. Millimetres in, cells out.
 */

import { EPSILON } from '../../domain/geometry';
import { boundsOf } from '../../domain/polygon';
import type { Point } from '../../domain/types';

/**
 * Roughly how coarse the grid should be, in millimetres per cell.
 *
 * A module constant rather than a `SolverConfig` field. It is an engine's
 * internal quality knob, and putting it on the domain config would mean
 * persisting it, migrating it, and inviting a user to choose a number whose only
 * observable effect is how long solving takes. `docs/plan-m7.md` §3.2 and §3.3
 * do not list one.
 *
 * 3mm is where the measured curve flattens on the M7 fixtures: a full 2440x1220
 * sheet is about 810x405 cells, one sheet fills in around 100ms, and halving it
 * costs four times that for a fraction of a percent of waste.
 */
const NEST_TARGET_CELL_MM = 3;

/**
 * The finest grid a very small kerf is allowed to demand.
 *
 * A laser-width 0.2mm kerf would otherwise ask for a 12-million-cell sheet and
 * hang the browser to save a fifth of a millimetre. Below this the grid stops
 * dividing the kerf and simply rounds it up, which is the safe direction.
 */
const NEST_MIN_CELL_MM = 1;

/**
 * The cell size to grid a sheet at, given the kerf.
 *
 * **Derived from the kerf rather than fixed, and that is worth a paragraph**,
 * because it is where most of the engine's quality comes from. `dilationOffsets`
 * below can only separate two parts by a whole number of cells, so the gap it
 * actually leaves is the kerf *rounded up to a multiple of the cell*. On a 2mm
 * grid a 3mm kerf becomes a 4mm gap - which sounds negligible and is not: the
 * `bookshelf` fixture fits four 300mm rows on a 1210mm sheet at 3mm and only
 * three at 4mm, so that single millimetre costs an entire sheet.
 *
 * Making the cell divide the kerf removes the rounding completely, and it is
 * free - a 3mm kerf grids at 3mm, a 1/8" one at 3.175mm, a 6mm one at 3mm. What
 * is left is the rasterisation itself, which inflates a shape to its cell
 * boundaries and is bounded by one cell per part per axis.
 */
export function cellSizeFor(kerfMm: number): number {
  if (!Number.isFinite(kerfMm) || kerfMm <= 0) return NEST_TARGET_CELL_MM;
  const steps = Math.max(1, Math.round(kerfMm / NEST_TARGET_CELL_MM));
  return Math.max(NEST_MIN_CELL_MM, kerfMm / steps);
}

/**
 * A rectangular grid of bits, row-major, 32 cells per `Uint32Array` word.
 *
 * Rows are word-aligned - each starts at a fresh word - so shifting a mask
 * sideways never has to carry across a row boundary. Bit `k` of word `w` is
 * column `32w + k`, least-significant bit first, which is what makes a
 * left-shift move a shape to the right.
 *
 * Bits at columns `>= cols` inside the final word of a row are always zero.
 * `collide.ts` relies on that to clip at the right-hand edge without masking.
 */
export interface Mask {
  cols: number;
  rows: number;
  /** Words per row: `ceil(cols / 32)`, at least 1. */
  stride: number;
  bits: Uint32Array;
}

export function createMask(cols: number, rows: number): Mask {
  const safeCols = Math.max(0, cols);
  const safeRows = Math.max(0, rows);
  const stride = Math.max(1, Math.ceil(safeCols / 32));
  return { cols: safeCols, rows: safeRows, stride, bits: new Uint32Array(stride * safeRows) };
}

function setBit(mask: Mask, col: number, row: number): void {
  if (col < 0 || col >= mask.cols || row < 0 || row >= mask.rows) return;
  const index = row * mask.stride + (col >>> 5);
  const current = mask.bits[index];
  if (current === undefined) return;
  mask.bits[index] = (current | (1 << (col & 31))) >>> 0;
}

export function getBit(mask: Mask, col: number, row: number): boolean {
  if (col < 0 || col >= mask.cols || row < 0 || row >= mask.rows) return false;
  const word = mask.bits[row * mask.stride + (col >>> 5)];
  return word !== undefined && (word & (1 << (col & 31))) !== 0;
}

/** Number of set cells. Test and diagnostic use only - never on the packing path. */
export function popCount(mask: Mask): number {
  let total = 0;
  for (const word of mask.bits) {
    let v = word;
    while (v !== 0) {
      v &= v - 1;
      total += 1;
    }
  }
  return total;
}

/**
 * Rasterise a closed ring, anchored at its own bounding-box top-left.
 *
 * Cell `(0, 0)` covers the millimetre square at the polygon's `boundsOf` origin,
 * which is exactly where `placementPolygon` puts a placed part's bounds - so a
 * mask laid down at grid cell `(c, r)` describes the part placed at
 * `(usable.x + c * cell, usable.y + r * cell)` with no further correction.
 *
 * Coverage comes from two passes whose union is provably complete:
 *
 * 1. **A scanline through each cell row's midpoint.** A cell lying wholly inside
 *    the ring has that line running through it from side to side, so the span it
 *    contributes covers the cell.
 * 2. **A grid walk along every edge.** A cell the boundary passes through is
 *    marked whether or not any scanline caught it, which is what covers thin
 *    features, near-horizontal edges, and every cell on the outline itself.
 *
 * Anything the ring touches is in one case or the other, so nothing is missed -
 * the property the kerf guarantee rests on.
 */
export function rasterise(points: readonly Point[], cellMm: number): Mask {
  if (points.length < 3 || cellMm <= 0) return createMask(0, 0);

  const bounds = boundsOf(points);
  // `ceil` with an epsilon guard: a 100mm part on a 2mm grid is 50 cells, not
  // 51, but a 100.0000001mm one must not silently lose its last sliver.
  const cols = Math.max(1, Math.ceil(bounds.width / cellMm - EPSILON));
  const rows = Math.max(1, Math.ceil(bounds.height / cellMm - EPSILON));
  const mask = createMask(cols, rows);

  const local = points.map((p) => ({
    x: (p.x - bounds.x) / cellMm,
    y: (p.y - bounds.y) / cellMm,
  }));

  fillScanlines(mask, local);
  for (let i = 0; i < local.length; i += 1) {
    const a = local[i];
    const b = local[(i + 1) % local.length];
    if (a === undefined || b === undefined) continue;
    markSegment(mask, a, b);
  }
  return mask;
}

/**
 * Even-odd scanline fill, sampling each cell row at its midpoint.
 *
 * Edges are counted with a half-open rule (`y0 <= y < y1`) so a vertex landing
 * exactly on the sample line contributes one crossing rather than zero or two.
 * Getting that wrong flips the parity for the rest of the row and hollows out
 * the shape - which the edge walk would then paper over as an outline with no
 * interior, a much harder thing to notice than a missing shape.
 */
function fillScanlines(mask: Mask, local: readonly Point[]): void {
  const crossings: number[] = [];
  for (let row = 0; row < mask.rows; row += 1) {
    const y = row + 0.5;
    crossings.length = 0;

    for (let i = 0; i < local.length; i += 1) {
      const a = local[i];
      const b = local[(i + 1) % local.length];
      if (a === undefined || b === undefined) continue;
      const downward = a.y <= y && b.y > y;
      const upward = b.y <= y && a.y > y;
      if (!downward && !upward) continue;
      crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }

    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = crossings[i];
      const to = crossings[i + 1];
      if (from === undefined || to === undefined) continue;
      const first = Math.max(0, Math.floor(from));
      const last = Math.min(mask.cols - 1, Math.floor(to));
      for (let col = first; col <= last; col += 1) setBit(mask, col, row);
    }
  }
}

/**
 * Mark every cell a segment passes through, by grid traversal.
 *
 * Amanatides-Woo rather than point sampling: stepping along a segment and
 * marking the cell under each sample skips cells the line only clips a corner
 * of, and those are exactly the cells at a shape's extremities. Under-marking
 * one is the one failure mode that would make the kerf guarantee false rather
 * than merely loose.
 */
function markSegment(mask: Mask, a: Point, b: Point): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  let col = clamp(Math.floor(a.x), 0, mask.cols - 1);
  let row = clamp(Math.floor(a.y), 0, mask.rows - 1);
  const endCol = clamp(Math.floor(b.x), 0, mask.cols - 1);
  const endRow = clamp(Math.floor(b.y), 0, mask.rows - 1);

  setBit(mask, col, row);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  let tMaxX = stepX === 0 ? Number.POSITIVE_INFINITY : (col + (stepX > 0 ? 1 : 0) - a.x) / dx;
  let tMaxY = stepY === 0 ? Number.POSITIVE_INFINITY : (row + (stepY > 0 ? 1 : 0) - a.y) / dy;

  // Bounded rather than trusting the endpoint comparison to terminate: the
  // clamping above can put the start or end cell somewhere the walk never
  // reaches, and a packing loop is no place for a chance of spinning forever.
  const limit = mask.cols + mask.rows + 2;
  for (let step = 0; step < limit; step += 1) {
    if (col === endCol && row === endRow) return;
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) return;
      tMaxX += tDeltaX;
      col += stepX;
    } else {
      if (tMaxY > 1) return;
      tMaxY += tDeltaY;
      row += stepY;
    }
    if (col < 0 || col >= mask.cols || row < 0 || row >= mask.rows) return;
    setBit(mask, col, row);
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** A cell offset in the kerf structuring element. */
export interface CellOffset {
  di: number;
  dj: number;
}

export interface Dilated {
  mask: Mask;
  /** Cells of margin added on every side. The dilated origin is `-pad` from the exact one. */
  pad: number;
}

/**
 * The cell offsets a candidate must be clear of to guarantee a real kerf.
 *
 * This is the heart of the engine's correctness, so the derivation is written
 * out. Cell `(i, j)` covers the closed square `[i·c, (i+1)·c] x [j·c, (j+1)·c]`.
 * If a point `a` lies in cell `ca` and `b` in cell `cb`, the closest they can
 * possibly be is
 *
 * ```
 * L(Δ) = c · sqrt( max(0, |Δi| - 1)² + max(0, |Δj| - 1)² )
 * ```
 *
 * - the `-1` because adjacent cells touch, so neighbours are free to be zero
 * apart. Therefore: if every marked cell of one shape is at an offset with
 * `L(Δ) >= kerf` from every marked cell of the other, then **every** point pair
 * is at least `kerf` apart and the exact Euclidean separation `checkResult`
 * measures cannot be short. So the structuring element must contain every offset
 * with `L(Δ) < kerf`, and this returns exactly those.
 *
 * `docs/plan-m7.md` §3.5 states the rule as "dilate by the full kerf", which is
 * not sound on a grid: conservative rasterisation puts a point up to a half
 * diagonal from its cell's centre, so dilating by `kerf` alone leaves true
 * separation only `> kerf - c·√2` and the bench rejects the layout. The bound
 * above is the tightened form of the safe margin - it costs about one cell in
 * each axis rather than `√2` cells, and unlike the centre-distance version it is
 * exact rather than conservative twice over.
 *
 * The consequence to keep in mind: two nested parts end up between `kerf` and
 * roughly `kerf + 2c` apart. At `NEST_CELL_MM` that is about a millimetre per
 * side of clearance a perfect nester would not spend, which is the price of the
 * grid and is stated in the bench output rather than hidden.
 */
export function dilationOffsets(kerfMm: number, cellMm: number): CellOffset[] {
  const offsets: CellOffset[] = [];
  if (cellMm <= 0) return offsets;

  const reach = Math.max(0, Math.ceil(kerfMm / cellMm)) + 1;
  const kerfSquared = kerfMm * kerfMm;
  for (let dj = -reach; dj <= reach; dj += 1) {
    for (let di = -reach; di <= reach; di += 1) {
      // The zero offset is always in, whatever the kerf. `L(0) = 0`, so the
      // formula alone drops it when `kerf` is 0 - and two shapes sharing a cell
      // is the one way conservative rasterisation lets them genuinely overlap.
      // A kerf of 0 means parts may touch, never that they may intersect.
      if (di === 0 && dj === 0) {
        offsets.push({ di, dj });
        continue;
      }
      const gapX = Math.max(0, Math.abs(di) - 1) * cellMm;
      const gapY = Math.max(0, Math.abs(dj) - 1) * cellMm;
      // Strictly less: an offset whose closest approach is exactly the kerf is
      // legal, matching `approxGte(gap, kerf)` in `checkResult`.
      if (gapX * gapX + gapY * gapY < kerfSquared - EPSILON) offsets.push({ di, dj });
    }
  }
  return offsets;
}

/**
 * Grow a mask by a structuring element.
 *
 * The result is padded on all four sides by the element's reach, so a dilated
 * mask laid down at `(col - pad, row - pad)` covers the same ground as the exact
 * mask at `(col, row)` plus its kerf halo.
 */
export function dilate(mask: Mask, offsets: readonly CellOffset[]): Dilated {
  let pad = 0;
  for (const offset of offsets) {
    pad = Math.max(pad, Math.abs(offset.di), Math.abs(offset.dj));
  }

  const grown = createMask(mask.cols + 2 * pad, mask.rows + 2 * pad);
  for (let row = 0; row < mask.rows; row += 1) {
    for (let col = 0; col < mask.cols; col += 1) {
      if (!getBit(mask, col, row)) continue;
      for (const offset of offsets) {
        setBit(grown, col + pad + offset.di, row + pad + offset.dj);
      }
    }
  }
  return { mask: grown, pad };
}
