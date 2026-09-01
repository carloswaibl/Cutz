/**
 * Polygon primitives: hull, oriented bounding box, area, containment,
 * simplification, rigid transforms, separation.
 *
 * `geometry.ts` next door owns rectangles, which is all the guillotine packer
 * and the cut planner ever see. This file owns everything that is a shape
 * rather than a box - the outlines the importers measure, and the outlines the
 * nesting solver packs.
 *
 * These lived in `src/import/geometry.ts` until M7, back when only the
 * importers had a polygon to measure. `biome.json` bars `src/solver/**` from
 * importing `**\/import/**` - the file boundaries depend on `domain/`, never
 * the other way round - so a solver could not reach `convexHull`, `minAreaBox`
 * or `pointInPolygon` there. `docs/plan-m7.md` §3.1.
 *
 * Pure, headless, millimetres. Origin is top-left, x increases right, y
 * increases down - matching SVG, so no coordinate flip on the way in. Because
 * y grows downward, *clockwise* is the positive angular direction throughout
 * this file.
 *
 * Polygons are closed rings given as their vertices, with no repeated final
 * point: the edge from the last vertex back to the first is implied.
 */

import { approxEq, approxGte, approxLte, EPSILON, type Rect } from './geometry';
// `Point` is a model type - `Part.outline` is made of them - so it is declared
// in `types.ts`, which imports nothing, and callers take it from there. This
// file owns every operation on one.
import type { Part, Placement, Point, SolverMode } from './types';

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

// --- Simplification -------------------------------------------------------

/**
 * Drop vertices that do not change a ring's shape by more than `toleranceMm`.
 *
 * Douglas-Peucker. A flattened SVG arc arrives with hundreds of vertices that
 * describe a curve to a precision no saw or router can hold, and every one of
 * them is paid for again on every rasterisation and every separation test the
 * nester runs. Removing them is the cheapest speedup available and costs
 * nothing a woodworker can measure.
 *
 * Douglas-Peucker is defined on an open polyline, and a part outline is a
 * closed ring. Running it on the ring as though the first vertex were an
 * endpoint would pin whichever vertex happened to be stored first and let the
 * algorithm shave the shape asymmetrically around it - two copies of the same
 * part, stored starting from different vertices, would simplify differently and
 * stop grouping into a quantity. So the ring is cut at two well-separated
 * anchors - vertex 0 and the vertex farthest from it - and the two chains
 * between them are simplified independently.
 *
 * Never returns fewer than three points: a ring that simplifies away entirely
 * is a degenerate contour, and `isDegenerate` is the place that decides what to
 * do about one.
 */
export function simplify(points: readonly Point[], toleranceMm: number): Point[] {
  if (points.length <= 3 || toleranceMm <= 0) return [...points];

  const first = points[0];
  if (!first) return [...points];

  let farthest = 0;
  let farthestDistance = -1;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if (!p) continue;
    const distance = Math.hypot(p.x - first.x, p.y - first.y);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = i;
    }
  }

  // Every vertex coincides with the first, so there is no shape to preserve.
  if (farthest === 0) return [...points];

  const forward = douglasPeucker(points.slice(0, farthest + 1), toleranceMm);
  const backward = douglasPeucker([...points.slice(farthest), first], toleranceMm);

  // Both chains carry the anchors they were split at; the ring implies its
  // closing edge, so drop the duplicate at each join.
  const ring = [...forward.slice(0, -1), ...backward.slice(0, -1)];
  return ring.length >= 3 ? ring : [...points];
}

/** Douglas-Peucker over an open polyline. Both endpoints always survive. */
function douglasPeucker(chain: readonly Point[], toleranceMm: number): Point[] {
  if (chain.length <= 2) return [...chain];

  const start = chain[0];
  const end = chain[chain.length - 1];
  if (!start || !end) return [...chain];

  let worst = 0;
  let worstDistance = 0;
  for (let i = 1; i < chain.length - 1; i += 1) {
    const p = chain[i];
    if (!p) continue;
    const distance = pointToSegmentDistance(p, start, end);
    if (distance > worstDistance) {
      worstDistance = distance;
      worst = i;
    }
  }

  if (worstDistance <= toleranceMm) return [start, end];

  const left = douglasPeucker(chain.slice(0, worst + 1), toleranceMm);
  const right = douglasPeucker(chain.slice(worst), toleranceMm);
  return [...left.slice(0, -1), ...right];
}

// --- Rigid transforms -----------------------------------------------------

/**
 * Rotate a polygon about the origin.
 *
 * Clockwise for positive angles, because y grows downward here - the same
 * direction `OrientedBox.angle` reports and the same one `Placement.angleDeg`
 * means. Rotating about the origin rather than the polygon's own centre is what
 * lets a caller compose this with `translatePolygon` and get the part's
 * placement, which is the only thing either is used for.
 */
export function rotatePolygon(points: readonly Point[], angleDeg: number): Point[] {
  const turn = ((angleDeg % 360) + 360) % 360;
  if (turn === 0) return [...points];

  // Quarter turns are done with exact integers rather than through `Math.cos`,
  // which returns 6.1e-17 rather than 0 for 90 degrees. That noise is far below
  // any tolerance in this codebase, but a quarter turn is the *only* thing the
  // guillotine packer emits, so it is what every existing layout, every cut
  // plan and every benchmark baseline is built from - and there is no reason
  // for a 600mm part to come back 600.00000000000006mm wide.
  const exact = QUARTER_TURNS[turn];
  if (exact !== undefined) {
    const [cos, sin] = exact;
    return points.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
  }

  const radians = (turn * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

/** `[cos, sin]` for the turns that must be exact. */
const QUARTER_TURNS: Record<number, [number, number]> = {
  90: [0, 1],
  180: [-1, 0],
  270: [0, -1],
};

export function translatePolygon(points: readonly Point[], dx: number, dy: number): Point[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

// --- Separation and containment -------------------------------------------

/**
 * True when every vertex of `points` lies inside `rect`. Shared edges count as
 * inside, matching `containsRect`.
 *
 * A rectangle is convex, so a polygon is contained exactly when all of its
 * vertices are - no edge can bulge out between two contained endpoints. This is
 * the polygon form of invariant 2, "every placement lies fully within the
 * stock's usable area".
 */
export function polygonInRect(points: readonly Point[], rect: Rect): boolean {
  return points.every(
    (p) =>
      approxGte(p.x, rect.x) &&
      approxGte(p.y, rect.y) &&
      approxLte(p.x, rect.x + rect.width) &&
      approxLte(p.y, rect.y + rect.height),
  );
}

/**
 * The gap between two polygons, in millimetres. Positive when they are
 * disjoint, zero when they touch, negative when they overlap.
 *
 * **This is deliberately not the same rule as `clearance(Rect)` in
 * `geometry.ts`, and must not be reconciled with it.** `clearance` takes the
 * *larger* of the two axis gaps, because a guillotine layout's separations are
 * made by edge-to-edge saw cuts and a cut has an axis - two parts in different
 * columns need no vertical gap at all. This function measures the true
 * Euclidean gap, because a router bit has no axis of separation. For two
 * rectangles offset 3mm in x and 4mm in y, `clearance` is 4 and this is 5. Both
 * answers are right for their own machine, which is why `validate.ts` keeps the
 * rectangle fast path for guillotine mode rather than replacing it.
 *
 * When the polygons overlap the magnitude is a *lower bound* on the true
 * penetration depth, not the depth itself - see `deepestIntrusion`. Callers
 * need the sign to be correct, because that is the invariant; the magnitude
 * only tells a user roughly how badly two parts collide. Exact penetration
 * depth for concave polygons is a substantially larger problem and buys
 * nothing here.
 *
 * O(n·m) in the vertex counts. That is the validator's budget: the nester
 * collides on a raster grid and never calls this.
 */
export function polygonSeparation(a: readonly Point[], b: readonly Point[]): number {
  if (a.length === 0 || b.length === 0) return Number.POSITIVE_INFINITY;

  let minDistance = Number.POSITIVE_INFINITY;
  let crossing = false;

  for (let i = 0; i < a.length; i += 1) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    if (!a0 || !a1) continue;
    for (let j = 0; j < b.length; j += 1) {
      const b0 = b[j];
      const b1 = b[(j + 1) % b.length];
      if (!b0 || !b1) continue;
      if (segmentsIntersect(a0, a1, b0, b1)) crossing = true;
      const distance = segmentDistance(a0, a1, b0, b1);
      if (distance < minDistance) minDistance = distance;
    }
  }

  const depth = Math.max(deepestIntrusion(a, b), deepestIntrusion(b, a));
  if (!crossing && depth === 0) return minDistance;

  // Overlapping. Floored so the sign is total: two rings whose edges cross with
  // nothing of either sampling inside the other - a thin sliver of overlap -
  // would otherwise come back as a non-negative gap, which reads as "these do
  // not overlap".
  return -Math.max(depth, EPSILON);
}

/**
 * How far the deepest part of `points`' boundary reaches inside `polygon`, or
 * 0 if none of it does. A lower bound on penetration depth.
 *
 * Sampled at each vertex **and each edge midpoint**, not vertices alone. Two
 * rectangles overlapping in a full-height band - two parts in adjacent columns,
 * the most ordinary thing on a cut sheet - have no vertex of either strictly
 * inside the other and no properly crossing edge pair, because their top and
 * bottom edges are flush. Vertices alone would report that pair as not
 * overlapping at all. The midpoint of the intruding edge sits squarely inside
 * and measures the overlap exactly.
 *
 * Containment is decided by the metric margin rather than by `pointInPolygon`
 * alone, because a sample landing exactly on the other ring's boundary is a
 * coin flip under the even-odd rule - which is precisely what happens when two
 * parts are butted edge to edge. Requiring real depth makes touching read as
 * touching.
 *
 * The bound is not tight in general: a sliver of overlap that catches no sample
 * falls through to the crossing test, and if that misses too the pair reports a
 * gap near zero rather than a negative one. That degrades the *message* a user
 * reads, never the invariant - a near-zero gap is still below any real kerf and
 * still fails the check.
 */
function deepestIntrusion(points: readonly Point[], polygon: readonly Point[]): number {
  let deepest = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (!current || !next) continue;
    const midpoint = { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 };
    for (const p of [current, midpoint]) {
      if (!pointInPolygon(p, polygon)) continue;
      const distance = distanceToBoundary(p, polygon);
      if (distance > EPSILON && distance > deepest) deepest = distance;
    }
  }
  return deepest;
}

/** Shortest distance from a point to a ring's boundary, inside or out. */
function distanceToBoundary(p: Point, polygon: readonly Point[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (!a || !b) continue;
    const distance = pointToSegmentDistance(p, a, b);
    if (distance < nearest) nearest = distance;
  }
  return Number.isFinite(nearest) ? nearest : 0;
}

/** Shortest distance between two line segments. Zero when they touch or cross. */
function segmentDistance(a0: Point, a1: Point, b0: Point, b1: Point): number {
  if (segmentsIntersect(a0, a1, b0, b1)) return 0;
  return Math.min(
    pointToSegmentDistance(a0, b0, b1),
    pointToSegmentDistance(a1, b0, b1),
    pointToSegmentDistance(b0, a0, a1),
    pointToSegmentDistance(b1, a0, a1),
  );
}

/**
 * True when two segments touch or cross.
 *
 * The collinear-overlap case is left to the caller's distance fallback rather
 * than special-cased: two collinear touching segments have a zero point-to-
 * segment distance anyway, so `segmentDistance` reaches the same answer either
 * way and this stays the short version.
 */
function segmentsIntersect(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const d1 = cross(b0, b1, a0);
  const d2 = cross(b0, b1, a1);
  const d3 = cross(a0, a1, b0);
  const d4 = cross(a0, a1, b1);
  return (
    ((d1 > EPSILON && d2 < -EPSILON) || (d1 < -EPSILON && d2 > EPSILON)) &&
    ((d3 > EPSILON && d4 < -EPSILON) || (d3 < -EPSILON && d4 > EPSILON))
  );
}

// --- Model adapters -------------------------------------------------------

/**
 * The part's outline, or the four corners of its bounding box when it has none.
 *
 * This is what keeps `Part.outline` optional without turning the codebase into
 * the optional-field soup `CLAUDE.md` warns against: **no call site branches on
 * the field.** A hand-entered rectangle and an imported curve are both polygons
 * from here on. `docs/plan-m7.md` §7 decision 6.
 *
 * Returned clockwise in this y-down system, matching the winding an importer
 * produces for an outer contour.
 */
export function partOutline(part: Part): readonly Point[] {
  if (part.outline !== undefined && part.outline.length >= 3) return part.outline;
  return [
    { x: 0, y: 0 },
    { x: part.width, y: 0 },
    { x: part.width, y: part.height },
    { x: 0, y: part.height },
  ];
}

/**
 * Where a placed part's real geometry actually sits on its sheet.
 *
 * The single mapping from a `Placement` to a polygon, the way `placementRect`
 * is for boxes - and `placementRect` is now defined in terms of this one, so
 * the renderer, the exporters and the invariant checker cannot disagree about
 * where a turned part is.
 *
 * The part is rotated about its own origin and then translated so the **turned
 * shape's bounding-box top-left** lands on `placement.x/y`. Anchoring the bounds
 * rather than the rotated origin is what makes `Placement.x/y` go on meaning
 * what it has always meant - the top-left of the footprint. Rotating about the
 * origin alone would put a 90°-turned `w x h` part at `x ∈ [-h, 0]`, which is
 * not where any existing renderer draws it.
 */
export function placementPolygon(part: Part, placement: Placement): Point[] {
  const turned = rotatePolygon(partOutline(part), placement.angleDeg);
  const bounds = boundsOf(turned);
  return translatePolygon(turned, placement.x - bounds.x, placement.y - bounds.y);
}

/**
 * The footprint a placed part occupies on its sheet, excluding kerf.
 *
 * Lives here rather than in `geometry.ts` next to the other rectangle helpers
 * because it is no longer answerable with rectangles: an arbitrary angle needs
 * the real polygon, and `geometry.ts` is deliberately polygon-free and sits
 * *below* this file in the import graph. Splitting it into an axis-aligned
 * version there and a general one here would be worse - `geometry.ts`'s own
 * header warns that a packer and a checker which disagree about where a turned
 * part sits disagree about everything downstream, and two functions is exactly
 * how that happens.
 *
 * For the quarter turns guillotine emits this is arithmetically identical to
 * the pre-M7 width/height swap.
 */
export function placementRect(part: Part, placement: Placement): Rect {
  return boundsOf(placementPolygon(part, placement));
}

/**
 * How much sheet a part consumes, in mm².
 *
 * Mode-dependent, and that is correct rather than a fudge. A table saw cuts a
 * rectangle, so everything inside a part's bounding box is gone whatever shape
 * the part is - in guillotine mode a part consumes its box. A router follows the
 * outline, so the material outside it survives and can hold another part - in
 * nest mode a part consumes its outline.
 *
 * The consequence is that nest and guillotine waste percentages for the same
 * parts are not directly comparable, which the UI states rather than hides. One
 * function serves solver, validator and UI so the number can never be computed
 * two ways. `docs/plan-m7.md` §7 decision 4.
 */
export function placedArea(part: Part, mode: SolverMode): number {
  if (mode === 'guillotine') return part.width * part.height;
  return polygonArea(partOutline(part));
}

/**
 * True when a ring crosses itself.
 *
 * Only adjacency is exempt: consecutive edges share an endpoint by
 * construction, and the closing edge is adjacent to the first.
 *
 * Detects *proper* crossings, so a ring pinched to a single shared vertex - two
 * lobes meeting at a point - reads as clean. That suits what this is for: it
 * backs a warning, not an error, and the cost of missing a degenerate shape is
 * a message the user does not get, never a layout that is wrong.
 *
 * O(n²). It runs once per solve on parts that actually carry an outline, and
 * outlines arrive simplified, so the vertex counts are tens rather than the
 * hundreds a flattened curve starts life with.
 */
export function isSelfIntersecting(points: readonly Point[]): boolean {
  const n = points.length;
  if (n < 4) return false;

  for (let i = 0; i < n; i += 1) {
    const a0 = points[i];
    const a1 = points[(i + 1) % n];
    if (!a0 || !a1) continue;
    for (let j = i + 1; j < n; j += 1) {
      // Adjacent edges, and the closing edge against the first.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const b0 = points[j];
      const b1 = points[(j + 1) % n];
      if (!b0 || !b1) continue;
      if (segmentsIntersect(a0, a1, b0, b1)) return true;
    }
  }
  return false;
}

/** Shortest distance from a point to a segment, clamped to the segment's extent. */
function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON * EPSILON) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
