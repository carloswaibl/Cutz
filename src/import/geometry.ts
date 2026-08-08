/**
 * Polygon primitives for the importers: hull, oriented bounding box, area,
 * containment.
 *
 * `domain/geometry.ts` owns rectangles, which is all the packer and the cut
 * planner ever see. An imported file arrives as arbitrary polygons, and turning
 * one into the rectangle the rest of the app understands is this file's whole
 * job. Shared with M5's STL importer, which needs the same box around a slab's
 * outline that this one needs around a flattened path.
 *
 * Pure, headless, millimetres. Origin is top-left, x increases right, y
 * increases down - matching SVG, so no coordinate flip on the way in.
 *
 * The important decision here is that the box is the *minimum-area oriented*
 * one, not the axis-aligned one. A user who drew a 600x200 shelf at 30 degrees
 * on the canvas drew a 600x200 shelf; its axis-aligned footprint is 620x470 and
 * importing that would waste half a sheet and cut the part wrong.
 */

import { approxEq, EPSILON, type Rect } from '../domain/geometry';

export interface Point {
  x: number;
  y: number;
}

/**
 * A rectangle that need not be axis-aligned.
 *
 * `angle` is degrees clockwise (y grows downward, so clockwise is the positive
 * direction here) in `[0, 90)`. Beyond 90 degrees a rectangle repeats itself
 * with its sides swapped, so a wider range would report the same box two ways
 * and make two identical parts look different in the preview.
 */
export interface OrientedBox {
  /** Millimetres. Never rounded, unlike the angle - the formatter rounds, once. */
  width: number;
  /** Millimetres. */
  height: number;
  /** Degrees, `[0, 90)`. Zero when the shape is square to the canvas. */
  angle: number;
}

/**
 * How far off axis a shape may be drawn and still be reported as square to the
 * canvas.
 *
 * A drawing produced by an editor is square to within float noise, not exactly
 * square, and a preview reporting "0.03 degrees" invites a user to wonder what
 * went wrong when nothing did. Half a degree over a 600mm part is 5mm at the
 * corner, which is far more than any real drawing is off by accident, so this
 * cannot swallow a rotation somebody meant.
 */
export const ANGLE_SNAP_DEGREES = 0.5;

/**
 * The area below which a contour is not a shape at all.
 *
 * Deliberately tiny. This threshold *drops* geometry rather than flagging it,
 * so it must only ever catch things that could not be a part under any reading:
 * hairlines, coincident points, registration marks. A 2x2mm square is 4mm² and
 * survives - it is not a plausible part either, but that is the user's call to
 * make in the preview, not this file's to make silently.
 */
export const MIN_CONTOUR_AREA_MM2 = 1;

/**
 * The smallest extent a contour may have in its narrow axis.
 *
 * Area alone is not enough: a 200x0.05mm hairline is 10mm² and would pass.
 * Nothing a table saw produces is a twentieth of a millimetre wide.
 */
export const MIN_CONTOUR_EXTENT_MM = 0.1;

// --- Basic measures -------------------------------------------------------

/**
 * Twice the signed area of a polygon, positive when the winding is clockwise.
 *
 * Clockwise is positive rather than the textbook counter-clockwise because y
 * increases downward here. Doubled because the halving is pure arithmetic that
 * every caller would immediately undo - `polygonArea` does it once.
 */
export function signedArea2(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    total += a.x * b.y - b.x * a.y;
  }
  return total;
}

/** Unsigned area of a polygon, in mm². Winding-independent. */
export function polygonArea(points: readonly Point[]): number {
  return Math.abs(signedArea2(points)) / 2;
}

/** The axis-aligned bounds of a point set. Empty input gives a zero rect at the origin. */
export function boundsOf(points: readonly Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * True when `p` is inside `polygon`, by the even-odd ray-crossing rule.
 *
 * Used to decide whether one contour is a hole inside another, where the caller
 * has already established that the bounds nest. Points exactly on the boundary
 * are not a case that arises there - a hole shares no edge with its parent - so
 * they are left to fall whichever way the arithmetic lands rather than given a
 * rule that would suggest more precision than this has.
 */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    const straddles = a.y > p.y !== b.y > p.y;
    if (!straddles) continue;
    const crossingX = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (p.x < crossingX) inside = !inside;
  }
  return inside;
}

// --- Convex hull ----------------------------------------------------------

/**
 * Convex hull by Andrew's monotone chain.
 *
 * Returned counter-clockwise as drawn on screen, which in this y-down system is
 * the negative winding by `signedArea2`. Nothing downstream depends on that -
 * `minAreaBox` is winding-blind - but an unstated winding is the kind of thing
 * a later caller assumes wrongly, so it is stated and pinned by a test.
 *
 * O(n log n), and the sort is the expensive part. Collinear points are dropped,
 * which matters downstream: `minAreaBox` searches over hull *edges*, and a hull
 * carrying three collinear points would search the same edge direction three
 * times for the same answer.
 *
 * Fewer than three distinct points cannot bound an area, so the input comes
 * back deduplicated and sorted rather than being treated as an error - a caller
 * measuring a degenerate contour should get a degenerate box, not an exception.
 */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
  const distinct: Point[] = [];
  for (const p of sorted) {
    const last = distinct[distinct.length - 1];
    if (last && approxEq(last.x, p.x) && approxEq(last.y, p.y)) continue;
    distinct.push(p);
  }
  if (distinct.length < 3) return distinct;

  const build = (source: readonly Point[]): Point[] => {
    const chain: Point[] = [];
    for (const p of source) {
      while (chain.length >= 2) {
        const a = chain[chain.length - 2];
        const b = chain[chain.length - 1];
        if (!a || !b || cross(a, b, p) < -EPSILON) break;
        chain.pop();
      }
      chain.push(p);
    }
    chain.pop(); // shared with the start of the other chain
    return chain;
  };

  return [...build(distinct), ...build([...distinct].reverse())];
}

/** z of (b-a) x (c-a). Positive when a->b->c turns clockwise in y-down coordinates. */
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// --- Minimum-area oriented box --------------------------------------------

/**
 * The smallest-area rectangle enclosing a point set.
 *
 * Exact, not sampled. The minimum-area enclosing rectangle of a convex polygon
 * always has a side collinear with one of the hull's edges - so the whole
 * search is "try every hull edge as the box's orientation and keep the best",
 * and there is no angular step size to tune and no near-miss to explain.
 *
 * Dimensions are returned unrounded. Rounding here and again in the display
 * formatter is how a 600mm part becomes 599: the formatter is the one place
 * that gets to decide what a number looks like.
 */
export function minAreaBox(points: readonly Point[]): OrientedBox {
  const hull = convexHull(points);

  // A single point, or none, has no edge to orient against. Two points do: the
  // loop below handles them and returns a zero-height box along the segment,
  // which `isDegenerate` then rejects. Falling back to the axis-aligned bounds
  // here instead would report a 100mm diagonal line as a 100x100mm part.
  if (hull.length < 2) return { width: 0, height: 0, angle: 0 };

  let best: OrientedBox | null = null;
  let bestArea = Number.POSITIVE_INFINITY;

  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if (!a || !b) continue;

    const edgeLength = Math.hypot(b.x - a.x, b.y - a.y);
    if (edgeLength <= EPSILON) continue;

    // Unit vector along the edge, and its perpendicular. Projecting every hull
    // point onto this pair gives the box's extent in that orientation.
    const ux = (b.x - a.x) / edgeLength;
    const uy = (b.y - a.y) / edgeLength;

    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const extentU = maxU - minU;
    const extentV = maxV - minV;
    const boxArea = extentU * extentV;
    if (boxArea >= bestArea) continue;

    bestArea = boxArea;
    best = orient(extentU, extentV, Math.atan2(uy, ux));
  }

  // Only reachable if every hull edge had zero length, which deduplication
  // already rules out. Kept so the function is total rather than nullable.
  if (!best) return { width: 0, height: 0, angle: 0 };
  return best;
}

/**
 * Normalise an edge direction and the extents measured along it into a box.
 *
 * The same rectangle can be described four ways - each edge in turn taken as
 * "width" - and reporting the same part differently depending on which hull
 * edge happened to win is exactly the kind of instability that makes two
 * identical shapes fail to group into a quantity. So: the angle is folded into
 * `[0, 90)`, and the extents follow it rather than the other way round.
 */
function orient(extentAlongEdge: number, extentAcrossEdge: number, radians: number): OrientedBox {
  let degrees = ((((radians * 180) / Math.PI) % 360) + 360) % 360;

  // Snap before folding, not after. An edge at 89.7 degrees is square to the
  // canvas, and folding first would leave it at 89.7 in [0, 90) where snapping
  // it to 0 would report the part's width as its height - the dimensions have
  // to swap along with the angle, and here they still can.
  const nearestQuarter = Math.round(degrees / 90) * 90;
  if (Math.abs(degrees - nearestQuarter) <= ANGLE_SNAP_DEGREES) degrees = nearestQuarter % 360;

  // Every quarter turn exchanges the two extents; every half turn is the same
  // rectangle again.
  const quarterTurns = Math.floor(degrees / 90);
  const swapped = quarterTurns % 2 === 1;

  return {
    width: swapped ? extentAcrossEdge : extentAlongEdge,
    height: swapped ? extentAlongEdge : extentAcrossEdge,
    angle: degrees - quarterTurns * 90,
  };
}

/**
 * True when a contour has no meaningful extent - a hairline, a stray point, a
 * pair of coincident vertices.
 *
 * Both tests are needed. Area alone passes a 200x0.05mm hairline; extent alone
 * passes a 0.5x0.5mm dot that a very long thin real part would fail.
 */
export function isDegenerate(box: OrientedBox): boolean {
  const narrowest = Math.min(box.width, box.height);
  return narrowest < MIN_CONTOUR_EXTENT_MM || box.width * box.height < MIN_CONTOUR_AREA_MM2;
}
