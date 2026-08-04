/**
 * Rectangle primitives shared by the packer and the invariant checker.
 *
 * Both need identical predicates for "does this fit", "do these overlap" and
 * "how far apart are these". Implementing them twice is how a checker ends up
 * agreeing with the bug it exists to catch, so they live here once.
 *
 * The two adapters at the bottom turn model objects into rectangles. They live
 * here for the same reason: a packer and a checker that disagree about where a
 * rotated part sits, or about how much of a sheet is usable, disagree about
 * everything downstream.
 *
 * All values are millimetres. Origin is top-left, x increases right, y
 * increases down - matching SVG, so rendering needs no coordinate flip.
 */

import type { Part, Placement, Stock } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Comparison tolerance, in millimetres.
 *
 * Dimensions reach the domain through inch conversion (23-1/4" -> 590.55mm) and
 * through repeated addition of kerf while splitting free rectangles, so a part
 * that fits its slot exactly can miss by 1e-13mm. That is a float artefact, not
 * a woodworking fact. 1e-6mm is a nanometre - far below any real tolerance, far
 * above the noise floor for the ~1e3 magnitudes we work at.
 */
export const EPSILON = 1e-6;

export function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON;
}

/** `a <= b`, tolerant of float noise. */
export function approxLte(a: number, b: number): boolean {
  return a <= b + EPSILON;
}

/** `a >= b`, tolerant of float noise. */
export function approxGte(a: number, b: number): boolean {
  return a >= b - EPSILON;
}

export function right(r: Rect): number {
  return r.x + r.width;
}

export function bottom(r: Rect): number {
  return r.y + r.height;
}

export function area(r: Rect): number {
  return r.width * r.height;
}

/** True when the rectangle has no usable extent in at least one axis. */
export function isEmpty(r: Rect): boolean {
  return r.width <= EPSILON || r.height <= EPSILON;
}

/** True when `inner` lies entirely within `outer`. Shared edges are allowed. */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    approxGte(inner.x, outer.x) &&
    approxGte(inner.y, outer.y) &&
    approxLte(right(inner), right(outer)) &&
    approxLte(bottom(inner), bottom(outer))
  );
}

/** True when a `width` x `height` footprint fits inside `r`. */
export function fits(width: number, height: number, r: Rect): boolean {
  return approxLte(width, r.width) && approxLte(height, r.height);
}

/**
 * The gap between two rectangles, in millimetres.
 *
 * Positive is the free space separating them on their closest axis of
 * separation. Zero means they touch. Negative means they overlap, and the
 * magnitude is the smaller of the two penetration depths.
 *
 * Two rectangles are separated as soon as they clear each other on *one* axis -
 * parts in different columns need no vertical gap between them - so this takes
 * the larger of the two axis gaps, not the smaller.
 *
 * This is the primitive behind the kerf invariant: two placements are legal
 * when `clearance(a, b) >= kerf`, because every separation between two parts on
 * a sheet is produced by a saw cut, and every cut consumes a kerf of material.
 */
export function clearance(a: Rect, b: Rect): number {
  const gapX = Math.max(b.x - right(a), a.x - right(b));
  const gapY = Math.max(b.y - bottom(a), a.y - bottom(b));
  return Math.max(gapX, gapY);
}

/** True when the two rectangles share positive area. Touching edges do not count. */
export function overlaps(a: Rect, b: Rect): boolean {
  return clearance(a, b) < -EPSILON;
}

// --- Model adapters ------------------------------------------------------

/**
 * The footprint a placed part occupies on its sheet, excluding kerf.
 *
 * `rotated` means the part is turned 90°, so its width and height swap. The
 * placement's x/y is the top-left corner of that footprint either way.
 */
export function placementRect(part: Part, placement: Placement): Rect {
  return {
    x: placement.x,
    y: placement.y,
    width: placement.rotated ? part.height : part.width,
    height: placement.rotated ? part.width : part.height,
  };
}

/**
 * The area of a sheet that may actually be packed into.
 *
 * Factory edges on sheet goods are often not square, so `edgeTrim` is cut off
 * all four sides before anything is laid out. The trimmed-off material is still
 * material the user bought, so it counts as waste - it just cannot hold a part.
 *
 * The result can be empty or negative-sized when the trim is larger than the
 * sheet. `validate.ts` reports that as an input issue rather than clamping it,
 * because silently packing into a sheet the user described as unusable hides
 * the real mistake (usually a trim value entered in the wrong unit).
 */
export function usableArea(stock: Stock, edgeTrim: number): Rect {
  return {
    x: edgeTrim,
    y: edgeTrim,
    width: stock.width - 2 * edgeTrim,
    height: stock.height - 2 * edgeTrim,
  };
}
