/**
 * Contours and nesting: what is a hole in something else.
 *
 * Shared between both importers - originally SVG-only, moved here for M5
 * because a slab's top-face boundary loops (`stl/project.ts`) need exactly
 * the same outer-vs-hole decision a flattened SVG path's subpaths do. Nothing
 * below is specific to either source format: it operates on `Point[]` loops
 * that have already been classified as closed.
 */

import { containsRect } from '../domain/geometry';
import { boundsOf, type OrientedBox, type Point, pointInPolygon, polygonArea } from './geometry';

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
