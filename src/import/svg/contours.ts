/**
 * Polylines to contours: what closes, what is too small to be anything, and
 * what is a hole in something else.
 *
 * This is the last step before a shape becomes a part, and it is where a
 * drawing's sloppiness gets separated from its intent. A path whose ends miss
 * each other by a thousandth of a millimetre is closed and the author would be
 * baffled to hear otherwise; one that misses by four millimetres is an unclosed
 * outline, and telling them the size of the gap is what lets them find it.
 */

import { approxEq, containsRect } from '../../domain/geometry';
import {
  boundsOf,
  isDegenerate,
  minAreaBox,
  type OrientedBox,
  type Point,
  pointInPolygon,
  polygonArea,
} from '../geometry';
import type { Subpath } from './flatten';

/**
 * How far apart a path's ends may be and still count as closed.
 *
 * A tenth of a millimetre is a rounding artefact in somebody's editor, not a
 * decision they made, so it is forgiven silently rather than warned about. It
 * is also two orders of magnitude below anything a saw can act on, so nothing
 * that matters hides underneath it.
 */
export const CLOSE_GAP_TOLERANCE_MM = 0.1;

/** A closed ring in millimetres. The first point is not repeated at the end. */
export interface Contour {
  points: Point[];
  /** Cached because nesting compares it and grouping reports it. */
  box: OrientedBox;
}

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

// --- Nesting --------------------------------------------------------------

export interface NestedContours {
  /** The contours that become parts. */
  outers: Contour[];
  /** How many contours were inside another one. Reported, never placed. */
  holeCount: number;
}

/**
 * Separate outlines from the holes cut in them.
 *
 * A contour is a hole when it sits inside a strictly larger one - bounds nested
 * and a vertex genuinely inside, since nested bounds alone would call an L
 * shape's neighbour a hole. Holes do not become parts and do not change the
 * size of the contour they sit in: a table saw cuts edge to edge, so an
 * interior cutout is work the user does after the sheet is cut, not something
 * the layout can help with.
 *
 * A shape inside a hole is counted as a hole too. That is not a fine
 * distinction the saw can act on either, and the alternative - winding rules
 * and containment depth parity - is precision this cannot honestly claim.
 */
export function nestContours(contours: readonly Contour[]): NestedContours {
  const bounds = contours.map((contour) => boundsOf(contour.points));
  const areas = contours.map((contour) => polygonArea(contour.points));

  const outers: Contour[] = [];
  let holeCount = 0;

  for (let i = 0; i < contours.length; i += 1) {
    const contour = contours[i];
    const innerBounds = bounds[i];
    const innerArea = areas[i];
    if (!contour || !innerBounds || innerArea === undefined) continue;

    let isHole = false;
    for (let j = 0; j < contours.length && !isHole; j += 1) {
      if (j === i) continue;
      const candidate = contours[j];
      const outerBounds = bounds[j];
      const outerArea = areas[j];
      if (!candidate || !outerBounds || outerArea === undefined) continue;

      // Strictly larger, so a pair of identical duplicate paths - which
      // Illustrator emits routinely - does not swallow both of itself.
      if (outerArea <= innerArea) continue;
      if (!containsRect(outerBounds, innerBounds)) continue;

      const probe = contour.points[0];
      if (probe && pointInPolygon(probe, candidate.points)) isHole = true;
    }

    if (isHole) holeCount += 1;
    else outers.push(contour);
  }

  return { outers, holeCount };
}
