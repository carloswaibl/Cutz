/**
 * The thresholds that decide whether a contour is a shape at all.
 *
 * The polygon maths itself - hull, oriented bounding box, area, containment -
 * moved to `src/domain/polygon.ts` in M7, because `biome.json` bars
 * `src/solver/**` from importing `**\/import/**` and the nesting solver needs
 * the same primitives the importers do. What is left here is the part that was
 * never geometry: a policy about what a *part* is, which is an importer's
 * question and nobody else's. `docs/plan-m7.md` §3.1.
 *
 * Millimetres, like everything else on this side of the unit boundary.
 */

import type { OrientedBox } from '../domain/polygon';

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
