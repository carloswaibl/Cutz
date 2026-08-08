/**
 * Path data to polylines, in millimetres.
 *
 * The order of operations here is the whole point, and it is easy to get
 * backwards. The transform is applied to the path data *before* the curves are
 * subdivided, because the flattening tolerance is a physical distance - 0.05mm,
 * well inside any saw's accuracy - and a physical tolerance is meaningless when
 * applied to coordinates that are about to be scaled by a factor nobody has
 * looked at yet. Flatten first and a drawing scaled up 10x arrives with visible
 * facets on every curve; flatten last and the tolerance means what it says.
 *
 * So: `svg-pathdata` normalises the grammar down to moves, lines and cubics,
 * the matrix puts everything in millimetres, and subdivision runs last.
 *
 * Subdivision is deterministic - depth is driven by flatness alone, with no
 * state carried between segments - because re-importing the same file has to
 * produce the same parts. A user who imports, adjusts a sheet size and imports
 * again must not get a different cut list.
 */

import { type SVGCommand, SVGPathData } from 'svg-pathdata';
import type { Point } from '../geometry';
import type { Matrix } from './transform';

/**
 * How far a flattened polyline may deviate from the true curve, in mm.
 *
 * A twentieth of a millimetre is finer than a table saw can be set and finer
 * than plywood is flat. Going tighter buys nothing and costs vertices in every
 * hull and every containment test downstream.
 */
export const FLATTEN_TOLERANCE_MM = 0.05;

/**
 * Recursion cap for subdivision.
 *
 * At depth 16 a segment has been halved 65536 times over, so reaching the cap
 * means the input is pathological rather than merely curvy. The cap is what
 * stops a hand-crafted file from hanging the tab, since parsing runs on the
 * main thread by design.
 */
export const MAX_SUBDIVISION_DEPTH = 16;

/**
 * One contiguous run of drawing commands: everything from a `moveto` up to the
 * next one.
 *
 * `closedByZ` is kept separate from "the ends happen to meet" on purpose. A `Z`
 * is the author stating the shape is closed; endpoints landing within a tenth
 * of a millimetre is a drawing artefact we forgive. Conflating them would mean
 * an author who left a path genuinely open by 4mm gets no warning as long as
 * some other rule closed it for them.
 */
export interface Subpath {
  /** Millimetres, in document order. The first point is not repeated at the end. */
  points: Point[];
  closedByZ: boolean;
}

/**
 * Flatten a `d` attribute through a transform into polylines in millimetres.
 *
 * Returns `null` when the path data could not be read at all - a truncated `d`,
 * or one that does not start with a moveto. That is a reportable fact about the
 * file, not an exception: the caller names the element in a warning and carries
 * on with the rest of the drawing.
 */
export function flattenPath(
  d: string,
  ctm: Matrix,
  toleranceMm: number = FLATTEN_TOLERANCE_MM,
): Subpath[] | null {
  let commands: SVGCommand[];
  try {
    commands = new SVGPathData(d)
      .toAbs()
      // `false` keeps `Z` intact. The default rewrites it as a line back to the
      // subpath start, which draws the same picture and throws away the one bit
      // of information that says the author closed the shape deliberately.
      .normalizeHVZ(false, true, true)
      .normalizeST()
      .qtToC()
      .aToC()
      .matrix(ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f).commands;
  } catch {
    return null;
  }

  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let cursor: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  // Set by `Z`. A drawing command after a close starts a fresh subpath at the
  // point the closed one began, rather than continuing it.
  let closed = false;

  const open = (at: Point): Subpath => {
    const started: Subpath = { points: [at], closedByZ: false };
    subpaths.push(started);
    return started;
  };

  for (const command of commands) {
    switch (command.type) {
      case SVGPathData.MOVE_TO: {
        const at = { x: command.x, y: command.y };
        current = open(at);
        subpathStart = at;
        cursor = at;
        closed = false;
        break;
      }

      case SVGPathData.LINE_TO: {
        if (!current || closed) {
          current = open(subpathStart);
          cursor = subpathStart;
          closed = false;
        }
        const target = { x: command.x, y: command.y };
        current.points.push(target);
        cursor = target;
        break;
      }

      case SVGPathData.CURVE_TO: {
        if (!current || closed) {
          current = open(subpathStart);
          cursor = subpathStart;
          closed = false;
        }
        const target = { x: command.x, y: command.y };
        flattenCubic(
          current.points,
          cursor,
          { x: command.x1, y: command.y1 },
          { x: command.x2, y: command.y2 },
          target,
          toleranceMm,
          0,
        );
        cursor = target;
        break;
      }

      case SVGPathData.CLOSE_PATH:
        if (current) current.closedByZ = true;
        cursor = subpathStart;
        closed = true;
        break;

      default:
        // The normalisation pipeline above leaves only M, L, C and Z. Anything
        // else would be a change in `svg-pathdata`, not a property of the file.
        break;
    }
  }

  // A lone moveto draws nothing.
  return subpaths.filter((subpath) => subpath.points.length >= 2);
}

// --- Cubic subdivision ----------------------------------------------------

/**
 * Append the flattened form of one cubic to `out`, excluding its start point.
 *
 * Recursive de Casteljau: halve the curve until each half is within tolerance
 * of its own chord. Splitting at the midpoint rather than adaptively choosing
 * a parameter is what keeps this deterministic.
 */
function flattenCubic(
  out: Point[],
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  tolerance: number,
  depth: number,
): void {
  if (depth >= MAX_SUBDIVISION_DEPTH || isFlat(p0, p1, p2, p3, tolerance)) {
    out.push(p3);
    return;
  }

  const p01 = midpoint(p0, p1);
  const p12 = midpoint(p1, p2);
  const p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const split = midpoint(p012, p123);

  flattenCubic(out, p0, p01, p012, split, tolerance, depth + 1);
  flattenCubic(out, split, p123, p23, p3, tolerance, depth + 1);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * True when the chord is within `tolerance` of the curve everywhere.
 *
 * The usual test is how far the two control points sit off the chord, which
 * bounds the curve's own deviation. On its own it has a hole: control points
 * that are collinear with the chord but far past its ends describe a curve that
 * shoots out and comes back, and measures as perfectly flat. So the projection
 * of each control point onto the chord is checked as well. Real drawings never
 * do this; hand-written path data occasionally does, and the failure mode is a
 * part silently imported at the wrong size.
 */
function isFlat(p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number): boolean {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const chord = Math.hypot(dx, dy);

  // A closed loop in a single cubic has no chord to measure against, so fall
  // back to how far the control points stray from the shared endpoint.
  if (chord <= tolerance) {
    return (
      Math.hypot(p1.x - p0.x, p1.y - p0.y) <= tolerance &&
      Math.hypot(p2.x - p0.x, p2.y - p0.y) <= tolerance
    );
  }

  for (const control of [p1, p2]) {
    const ox = control.x - p0.x;
    const oy = control.y - p0.y;
    if (Math.abs(ox * dy - oy * dx) / chord > tolerance) return false;
    const along = (ox * dx + oy * dy) / (chord * chord);
    if (along < -0.5 || along > 1.5) return false;
  }
  return true;
}
