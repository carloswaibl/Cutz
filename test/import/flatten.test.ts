import { describe, expect, it } from 'vitest';
import { minAreaBox } from '../../src/domain/polygon';
import type { Point } from '../../src/domain/types';
import { FLATTEN_TOLERANCE_MM, flattenPath } from '../../src/import/svg/flatten';
import { IDENTITY, type Matrix, parseTransform, scaling } from '../../src/import/svg/transform';

/** `flattenPath`, asserting the path data was readable. */
function flattened(d: string, ctm: Matrix = IDENTITY) {
  const subpaths = flattenPath(d, ctm);
  if (!subpaths) throw new Error(`expected to flatten: ${d}`);
  return subpaths;
}

/** The largest radial error of a polyline against a circle it is meant to trace. */
function radialError(points: readonly Point[], cx: number, cy: number, radius: number): number {
  let worst = 0;
  for (const point of points) {
    worst = Math.max(worst, Math.abs(Math.hypot(point.x - cx, point.y - cy) - radius));
  }
  return worst;
}

/** A full circle of radius `r` centred on the origin, as four cubic arcs. */
function circlePath(r: number): string {
  return `M ${-r} 0 A ${r} ${r} 0 1 0 ${r} 0 A ${r} ${r} 0 1 0 ${-r} 0 Z`;
}

describe('flattenPath', () => {
  it('reads a simple polygon', () => {
    const [subpath] = flattened('M 0 0 L 100 0 L 100 50 L 0 50 Z');
    expect(subpath?.closedByZ).toBe(true);
    expect(subpath?.points).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ]);
  });

  it('keeps Z distinct from a path that merely ends where it started', () => {
    // The default `normalizeHVZ()` rewrites Z as a line back to the start,
    // which draws the same picture and throws away the author's statement that
    // the shape is closed. `contours.ts` needs that statement.
    const [closed] = flattened('M 0 0 L 100 0 L 100 50 Z');
    const [open] = flattened('M 0 0 L 100 0 L 100 50');
    expect(closed?.closedByZ).toBe(true);
    expect(open?.closedByZ).toBe(false);
  });

  it('normalises relative, horizontal and vertical commands', () => {
    const [subpath] = flattened('m 10 10 h 100 v 50 h -100 z');
    expect(subpath?.points).toEqual([
      { x: 10, y: 10 },
      { x: 110, y: 10 },
      { x: 110, y: 60 },
      { x: 10, y: 60 },
    ]);
  });

  it('splits a compound path into one subpath per moveto', () => {
    // Illustrator emits a whole set of panels as one compound path.
    const subpaths = flattened('M 0 0 H 100 V 50 H 0 Z M 200 0 H 300 V 50 H 200 Z');
    expect(subpaths).toHaveLength(2);
    expect(minAreaBox(subpaths[0]?.points ?? []).width).toBeCloseTo(100, 9);
    expect(minAreaBox(subpaths[1]?.points ?? []).width).toBeCloseTo(100, 9);
  });

  it('starts a new subpath when drawing continues after a close', () => {
    const subpaths = flattened('M 0 0 H 100 V 50 Z L 40 90 L -20 40 Z');
    expect(subpaths).toHaveLength(2);
    // The second begins where the first did, per the spec.
    expect(subpaths[1]?.points[0]).toEqual({ x: 0, y: 0 });
    expect(subpaths[1]?.closedByZ).toBe(true);
  });

  it('drops a lone moveto, which draws nothing', () => {
    expect(flattened('M 10 10')).toEqual([]);
  });

  it('flattens a circle to within tolerance of its true radius', () => {
    const [subpath] = flattened(circlePath(150));
    expect(radialError(subpath?.points ?? [], 0, 0, 150)).toBeLessThanOrEqual(FLATTEN_TOLERANCE_MM);
  });

  it('flattens quadratics and smooth curves too', () => {
    for (const d of ['M 0 0 Q 50 100 100 0', 'M 0 0 C 20 60 80 60 100 0 S 180 -60 200 0']) {
      const [subpath] = flattened(d);
      expect((subpath?.points.length ?? 0) > 2).toBe(true);
    }
  });

  it('holds the tolerance after a 10x transform, because the matrix runs first', () => {
    // The load-bearing test for the ordering in this module. Flattening before
    // the matrix would meet the tolerance in user units and then multiply the
    // error by ten, putting visible facets on every curve.
    const [subpath] = flattened(circlePath(15), scaling(10, 10));
    expect(radialError(subpath?.points ?? [], 0, 0, 150)).toBeLessThanOrEqual(FLATTEN_TOLERANCE_MM);
  });

  it('subdivides more finely as the scale grows, rather than a fixed amount', () => {
    const small = flattened(circlePath(15))[0]?.points.length ?? 0;
    const large = flattened(circlePath(15), scaling(10, 10))[0]?.points.length ?? 0;
    expect(large).toBeGreaterThan(small);
  });

  it('applies the transform to the geometry it produces', () => {
    const ctm = parseTransform('translate(100,50) rotate(90)');
    if (!ctm) throw new Error('expected to parse');
    const [subpath] = flattened('M 0 0 L 10 0 L 10 4 L 0 4 Z', ctm);
    const box = minAreaBox(subpath?.points ?? []);
    // A quarter turn: the 10x4 rectangle becomes 4x10.
    expect(box.width).toBeCloseTo(4, 6);
    expect(box.height).toBeCloseTo(10, 6);
    expect(subpath?.points[0]?.x).toBeCloseTo(100, 6);
    expect(subpath?.points[0]?.y).toBeCloseTo(50, 6);
  });

  it('produces identical output for the same input twice', () => {
    // A user who imports, changes a sheet size and imports again must get the
    // same cut list. Subdivision is depth-driven with no carried state, and
    // this is what pins that.
    const d = `${circlePath(150)} M 300 0 C 320 60 380 60 400 0`;
    expect(flattened(d, scaling(3, 3))).toEqual(flattened(d, scaling(3, 3)));
  });

  it('reports unreadable path data rather than throwing', () => {
    expect(flattenPath('L 10 10', IDENTITY)).toBeNull();
    expect(flattenPath('M 0 0 L', IDENTITY)).toBeNull();
    expect(flattenPath('not path data at all', IDENTITY)).toBeNull();
  });

  it('terminates on a cubic whose controls are collinear but far past the chord', () => {
    // Measures as perfectly flat under the usual perpendicular-distance test,
    // while the curve itself shoots well outside the chord.
    const [subpath] = flattened('M 0 0 C 300 0 -200 0 100 0');
    expect((subpath?.points.length ?? 0) > 2).toBe(true);
  });
});
