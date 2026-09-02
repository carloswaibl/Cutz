/**
 * Bottom-left-fill over a part's allowed orientations.
 *
 * The engine's only placement rule: of every cell position where a part clears
 * everything already on the sheet, take the one with the lowest `y`, then the
 * lowest `x`, then the earliest orientation. Simple, and the reason it works for
 * nesting is that "lowest y first" is what drives a turned part down into the
 * concavity of one already placed - the thing a bounding-box packer can never do.
 *
 * **No randomness and no wall-clock here.** Every tie breaks on an index, so one
 * candidate ordering always produces one layout. What varies between attempts is
 * the ordering, which `search.ts` supplies.
 *
 * Pure and headless.
 */

import { containsRect, EPSILON, type Rect } from '../../domain/geometry';
import { boundsOf, rotatePolygon } from '../../domain/polygon';
import type { Part, Point } from '../../domain/types';
import { collides, type Occupancy } from './collide';
import { type CellOffset, dilate, type Mask, rasterise } from './raster';

/**
 * One orientation of one part, rasterised once and reused for the whole solve.
 *
 * `exact` is what gets written to the sheet; `dilated` is what gets tested
 * against it, and sits `pad` cells further out on every side.
 */
export interface Orientation {
  angleDeg: number;
  /** Bounding box of the turned outline, in millimetres. Anchored at the origin. */
  width: number;
  height: number;
  exact: Mask;
  dilated: Mask;
  pad: number;
}

/** Where a part ended up: which orientation, and which cell its bounds start at. */
export interface Placed {
  orientation: Orientation;
  /** Index into the `candidates` array, so the caller can advance its cursor. */
  index: number;
  col: number;
  row: number;
}

/**
 * Where one orientation's scan may resume, per sheet.
 *
 * Bottom-left-fill returns the *minimum* free position in `(row, col)` order,
 * and a sheet only ever gains occupancy - nothing is unplaced. So the set of
 * free positions for a given orientation only shrinks, and the minimum of a
 * shrinking set only moves forward. Whatever else was placed in between, the
 * next copy of the same part in the same orientation cannot land before where
 * the last one did.
 *
 * That makes resuming exact rather than a heuristic, and it is the difference
 * between twenty identical brackets costing one scan of the sheet and costing
 * twenty. A sheet's cursors are discarded with the sheet.
 */
export interface Cursor {
  row: number;
  col: number;
}

/**
 * Rasterise one part at one angle.
 *
 * The turned outline is re-anchored at its own bounding-box top-left before
 * rasterising, which is exactly what `placementPolygon` does when it maps a
 * `Placement` back to geometry. That correspondence is the whole reason a mask
 * at cell `(c, r)` can be reported as a placement at
 * `(usable.x + c·cell, usable.y + r·cell)` with no further correction - and it
 * is what makes `checkResult` agree with the packer about where a part is.
 */
export function orient(
  outline: readonly Point[],
  angleDeg: number,
  cellMm: number,
  kerfOffsets: readonly CellOffset[],
): Orientation {
  const turned = rotatePolygon(outline, angleDeg);
  const bounds = boundsOf(turned);
  const anchored = turned.map((p) => ({ x: p.x - bounds.x, y: p.y - bounds.y }));

  const exact = rasterise(anchored, cellMm);
  const grown = dilate(exact, kerfOffsets);
  return {
    angleDeg,
    width: bounds.width,
    height: bounds.height,
    exact,
    dilated: grown.mask,
    pad: grown.pad,
  };
}

/**
 * True when two orientations rasterise identically.
 *
 * A rectangle at 0° and at 180° is the same shape in the same box, and a
 * four-step search offers both. Dropping the duplicate halves the scan for every
 * symmetric part without changing any answer - the survivor is the earlier
 * angle, and the scan already breaks ties towards it.
 */
function sameShape(a: Orientation, b: Orientation): boolean {
  if (a.exact.cols !== b.exact.cols || a.exact.rows !== b.exact.rows) return false;
  for (let i = 0; i < a.exact.bits.length; i += 1) {
    if (a.exact.bits[i] !== b.exact.bits[i]) return false;
  }
  return true;
}

/** Rasterise every orientation a part is allowed, dropping duplicates. */
export function orientations(
  part: Part,
  outline: readonly Point[],
  angles: readonly number[],
  cellMm: number,
  kerfOffsets: readonly CellOffset[],
): Orientation[] {
  const distinct: Orientation[] = [];
  for (const angle of angles) {
    const candidate = orient(outline, angle, cellMm, kerfOffsets);
    if (candidate.exact.cols === 0 || candidate.exact.rows === 0) continue;
    if (distinct.some((existing) => sameShape(existing, candidate))) continue;
    distinct.push(candidate);
  }
  // A part whose outline degenerates to nothing on this grid still has to be
  // placeable, or it would be reported as a shortfall for being small.
  if (distinct.length === 0 && part.width > 0 && part.height > 0) {
    distinct.push(orient(outline, 0, cellMm, kerfOffsets));
  }
  return distinct;
}

/**
 * The bottom-left-most legal position for a part, or `null` if it fits nowhere.
 *
 * Two tests gate a position, and they are deliberately different in kind:
 *
 * - **Clearance is decided on the grid, and the grid's answer is final.** The
 *   dilated mask carries the kerf, and `dilationOffsets` proves the resulting
 *   Euclidean gap is at least the kerf. No polygon arithmetic runs in this loop;
 *   putting it here is what would make nesting unaffordable in a browser.
 * - **Containment is decided exactly, off the grid.** A polygon lies inside a
 *   rectangle exactly when its bounds do, so this is `containsRect` on the
 *   turned bounds - arithmetically the same predicate `checkResult` applies with
 *   `polygonInRect`. Doing it on the grid instead would mean eroding the usable
 *   area to cover rasterisation slop, and spending real material at an edge
 *   where no cut happens and no clearance is owed.
 */
export function findPlacement(
  occupancy: Occupancy,
  candidates: readonly Orientation[],
  usable: Rect,
  cellMm: number,
  cursors?: Cursor[],
): Placed | null {
  let best: Placed | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const orientation = candidates[index];
    if (orientation === undefined) continue;

    // Positions are pruned to those where the part itself is inside the usable
    // area, so the scan never even considers one that containment would reject.
    // The epsilon is not cosmetic: a part sized by inch conversion can miss its
    // sheet by 1e-13mm, and without it an exactly-fitting part would be reported
    // as a shortfall rather than placed at column zero.
    const lastCol = Math.floor((usable.width - orientation.width) / cellMm + EPSILON);
    const lastRow = Math.floor((usable.height - orientation.height) / cellMm + EPSILON);
    if (lastCol < 0 || lastRow < 0) continue;

    const cursor = cursors?.[index];
    const startRow = cursor?.row ?? 0;
    const rowLimit = best === null ? lastRow : Math.min(lastRow, best.row);

    for (let row = startRow; row <= rowLimit; row += 1) {
      const colLimit = best !== null && row === best.row ? best.col - 1 : lastCol;
      // On the cursor's own row the previous copy already proved everything to
      // its left is taken, so the scan restarts one column further along.
      const startCol = cursor !== undefined && row === cursor.row ? cursor.col : 0;
      for (let col = startCol; col <= colLimit; col += 1) {
        if (collides(occupancy, orientation.dilated, col - orientation.pad, row - orientation.pad))
          continue;

        // Belt and braces against float drift in the `lastCol`/`lastRow` bound:
        // the exact predicate, on the same rectangle `checkResult` will use.
        const footprint: Rect = {
          x: usable.x + col * cellMm,
          y: usable.y + row * cellMm,
          width: orientation.width,
          height: orientation.height,
        };
        if (!containsRect(usable, footprint)) continue;

        best = { orientation, index, col, row };
        break;
      }
      if (best !== null && best.orientation === orientation) break;
    }
  }

  return best;
}
