/**
 * A measured contour becomes a part's true outline.
 *
 * Until M7 this step did not exist: both importers computed a contour's oriented
 * box, pushed the box onward, and let the polygon fall out of scope. The
 * polygon was never missing - it was discarded, at one line each, because a
 * table saw cuts a rectangle and there was nothing downstream that could use a
 * shape. `docs/plan-m7.md` §1 criterion 2.
 *
 * What comes out is part-local: origin at the bounding box's top-left, x right,
 * y down, square to its own box however the shape was drawn on the canvas. That
 * is the coordinate system `Part.outline` is defined in, and the reason this
 * conversion is a named step rather than a `contour.points` passed along - the
 * points a contour carries are in the *drawing's* space, at whatever angle the
 * author drew them.
 *
 * Shared by both importers, like `contours.ts` and `group.ts` next door, and
 * for the same reason: nothing below is specific to a file format.
 */

import { approxEq } from '../domain/geometry';
import { fitPolygonToBox, rotatePolygon, signedArea2, simplify } from '../domain/polygon';
import type { Point } from '../domain/types';
import type { Contour } from './contours';

/**
 * How far a simplified outline may depart from the curve it came from.
 *
 * A flattened SVG arc arrives with hundreds of vertices describing a curve to a
 * precision no saw or router can hold, and every one of them is paid for again
 * on every rasterisation and every separation test the nester runs. Dropping
 * them is the cheapest speedup available.
 *
 * A tenth of a millimetre is the same figure `CLOSE_GAP_TOLERANCE_MM` uses for
 * the same reason - it is a rounding artefact in somebody's editor, not a
 * decision they made. It also sits a clear order of magnitude below
 * `GROUP_TOLERANCE_MM`, which matters: simplification must never move a shape
 * far enough to change which quantity group it lands in.
 */
export const OUTLINE_SIMPLIFY_TOLERANCE_MM = 0.1;

/**
 * A contour's polygon in the coordinates `Part.outline` is defined in.
 *
 * Four steps, and the order is load-bearing:
 *
 * 1. **Un-rotate by the box's own angle.** `minAreaBox` reports the angle folded
 *    into `[0, 90)` with the extents swapped to follow it, so turning the points
 *    by exactly `-angle` lands the min-area box on the axes and makes `boundsOf`
 *    agree with `box.width` x `box.height` - in both the swapped and unswapped
 *    cases, which is why this is `-angle` and not a quarter-turn correction. A
 *    shelf drawn at 30 degrees becomes a shelf.
 * 2. **Simplify**, per the tolerance above. Done here rather than before
 *    `minAreaBox` deliberately: the box is what every existing part dimension,
 *    label and quantity group is built from, and it must come out of this
 *    milestone bit-identical.
 * 3. **Normalise the winding to clockwise.** `partOutline()` documents its
 *    return as clockwise, and a hand-entered rectangle's fallback corners are.
 *    An SVG path may be drawn either way and a mirroring transform flips it, so
 *    without this the promise holds by luck. Positive signed area is clockwise
 *    here because y grows downward.
 * 4. **Fit to the box exactly.** Steps 1 and 2 each move the bounds by a
 *    fraction of a millimetre, and `outline-bounds-mismatch` is an error that
 *    blocks solving. See `fitPolygonToBox`.
 */
export function partLocalOutline(contour: Contour): Point[] {
  const square = rotatePolygon(contour.points, -contour.box.angle);
  const thinned = simplify(square, OUTLINE_SIMPLIFY_TOLERANCE_MM);
  const wound = signedArea2(thinned) > 0 ? thinned : [...thinned].reverse();
  return fitPolygonToBox(wound, contour.box.width, contour.box.height);
}

/**
 * True when a ring is nothing more than its own bounding box.
 *
 * An SVG `<rect>` is the overwhelmingly common case in a woodworking drawing,
 * and storing four corners that `partOutline()` would have synthesised anyway
 * buys nothing: it is redundant geometry in every project record, and it makes
 * an imported panel structurally different from a typed one for no reason a
 * user could observe. So a row that measures as its own box carries no outline
 * at all, and `Part.outline` keeps meaning "this part is not a rectangle".
 *
 * Order matters as well as position - the ring has already been wound clockwise
 * from the top-left by `partLocalOutline`, so a genuine box arrives in exactly
 * this sequence and a four-vertex shape that merely touches all four corners
 * (a diamond, say) does not.
 */
export function isBoxOutline(points: readonly Point[], width: number, height: number): boolean {
  if (points.length !== 4) return false;
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  // Any rotation of the same cycle is the same rectangle: which vertex a path
  // happened to start at is the author's editor talking, not their intent.
  return corners.some((_, offset) =>
    corners.every((corner, i) => {
      const p = points[(i + offset) % 4];
      return p !== undefined && approxEq(p.x, corner.x) && approxEq(p.y, corner.y);
    }),
  );
}
