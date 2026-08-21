/**
 * Flattened subpaths to contours: what closes, and what is too small to be
 * anything.
 *
 * This is the last step before a shape becomes a part, and it is where a
 * drawing's sloppiness gets separated from its intent. A path whose ends miss
 * each other by a thousandth of a millimetre is closed and the author would be
 * baffled to hear otherwise; one that misses by four millimetres is an unclosed
 * outline, and telling them the size of the gap is what lets them find it.
 *
 * `Contour` and `nestContours` live in `../contours.ts` now - shared with
 * M5's STL importer - because they were already fully generic. Only the
 * SVG-specific step of turning a flattened `Subpath` into a `Contour` stays
 * here.
 */

import { approxEq } from '../../domain/geometry';
import { CLOSE_GAP_TOLERANCE_MM, type Contour } from '../contours';
import { isDegenerate, minAreaBox, type Point } from '../geometry';
import type { Subpath } from './flatten';

export type ContourClass =
  | { kind: 'closed'; contour: Contour }
  /** Not a part. `gapMm` is how far the ends missed, which is what locates it. */
  | { kind: 'open'; gapMm: number }
  /** No real extent: a construction line, a registration mark, a stray point. */
  | { kind: 'degenerate' };

/**
 * Decide what one flattened subpath is.
 *
 * Degeneracy is tested before closure, and the order matters. A construction
 * line is both degenerate and open, and reporting it as "not closed - the gap
 * is 300mm, close the path and export again" is advice about a line the user
 * never intended as a part. Those fold into the degenerate count instead, which
 * is one line in the warnings rather than one per stray mark.
 */
export function classifySubpath(subpath: Subpath): ContourClass {
  const points = withoutRepeatedPoints(subpath.points);
  if (points.length < 3) return { kind: 'degenerate' };

  const box = minAreaBox(points);
  if (isDegenerate(box)) return { kind: 'degenerate' };

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return { kind: 'degenerate' };

  const gapMm = Math.hypot(last.x - first.x, last.y - first.y);
  if (!subpath.closedByZ && gapMm > CLOSE_GAP_TOLERANCE_MM) return { kind: 'open', gapMm };

  return { kind: 'closed', contour: { points, box } };
}

/**
 * Drop coincident neighbours, and the closing point when it repeats the first.
 *
 * Flattening produces a duplicate wherever a segment ends exactly where the
 * next begins, and authors routinely write the start point again before `Z`.
 * Both leave zero-length edges, which `convexHull` would then have to dedupe
 * anyway and `pointInPolygon` would divide by.
 */
function withoutRepeatedPoints(points: readonly Point[]): Point[] {
  const kept: Point[] = [];
  for (const p of points) {
    const last = kept[kept.length - 1];
    if (last && approxEq(last.x, p.x) && approxEq(last.y, p.y)) continue;
    kept.push(p);
  }
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (kept.length > 1 && first && last && approxEq(first.x, last.x) && approxEq(first.y, last.y)) {
    kept.pop();
  }
  return kept;
}
