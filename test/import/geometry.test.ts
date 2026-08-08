import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  convexHull,
  isDegenerate,
  minAreaBox,
  type Point,
  pointInPolygon,
  polygonArea,
  signedArea2,
} from '../../src/import/geometry';

const p = (x: number, y: number): Point => ({ x, y });

/** A rectangle's four corners, rotated `degrees` clockwise about the origin. */
function rotatedRect(width: number, height: number, degrees: number): Point[] {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [p(0, 0), p(width, 0), p(width, height), p(0, height)].map((corner) =>
    p(corner.x * cos - corner.y * sin, corner.x * sin + corner.y * cos),
  );
}

/** A circle sampled finely enough that its hull is a good stand-in for the curve. */
function circle(radius: number, samples = 720): Point[] {
  return Array.from({ length: samples }, (_, i) => {
    const t = (i / samples) * 2 * Math.PI;
    return p(radius * Math.cos(t), radius * Math.sin(t));
  });
}

describe('convexHull', () => {
  it('drops points inside the hull', () => {
    const hull = convexHull([p(0, 0), p(10, 0), p(10, 10), p(0, 10), p(5, 5), p(2, 8)]);
    expect(hull).toHaveLength(4);
  });

  it('drops collinear points on a hull edge', () => {
    // minAreaBox searches over hull edges, so a hull carrying three collinear
    // points would search the same orientation three times for one answer.
    const hull = convexHull([p(0, 0), p(5, 0), p(10, 0), p(10, 10), p(0, 10)]);
    expect(hull).toHaveLength(4);
  });

  it('comes back counter-clockwise as drawn on screen', () => {
    // Pinned because it is not otherwise observable, and a later caller that
    // assumes the opposite would get a sign error rather than a crash.
    expect(signedArea2(convexHull([p(0, 0), p(10, 0), p(10, 10), p(0, 10)]))).toBeLessThan(0);
  });

  it('survives degenerate input rather than throwing', () => {
    expect(convexHull([])).toEqual([]);
    expect(convexHull([p(3, 4)])).toEqual([p(3, 4)]);
    expect(convexHull([p(1, 1), p(1, 1), p(1, 1)])).toEqual([p(1, 1)]);
    expect(convexHull([p(0, 0), p(10, 10)])).toHaveLength(2);
  });
});

describe('minAreaBox', () => {
  it('returns an axis-aligned rectangle as itself, at angle 0', () => {
    const box = minAreaBox([p(0, 0), p(600, 0), p(600, 200), p(0, 200)]);
    expect(box.width).toBeCloseTo(600, 9);
    expect(box.height).toBeCloseTo(200, 9);
    expect(box.angle).toBe(0);
  });

  it('returns the same dimensions for the same rectangle drawn at an angle', () => {
    // This is the entire reason the box is minimum-area rather than
    // axis-aligned. A 600x200 shelf drawn at 30 degrees has an axis-aligned
    // footprint of 620x470 - importing that would cut the part wrong and waste
    // half a sheet.
    const box = minAreaBox(rotatedRect(600, 200, 30));
    const sides = [box.width, box.height].sort((a, b) => b - a);
    expect(sides[0]).toBeCloseTo(600, 6);
    expect(sides[1]).toBeCloseTo(200, 6);
    expect(box.angle).toBeCloseTo(30, 6);
  });

  it('measures a rotated rectangle the same at every angle', () => {
    for (let degrees = 0; degrees < 180; degrees += 7) {
      const box = minAreaBox(rotatedRect(600, 200, degrees));
      const sides = [box.width, box.height].sort((a, b) => b - a);
      expect(sides[0]).toBeCloseTo(600, 6);
      expect(sides[1]).toBeCloseTo(200, 6);
    }
  });

  it('reports a square as a square whatever angle it is drawn at', () => {
    for (const degrees of [0, 17, 45, 63, 89]) {
      const box = minAreaBox(rotatedRect(300, 300, degrees));
      expect(box.width).toBeCloseTo(300, 6);
      expect(box.height).toBeCloseTo(300, 6);
    }
  });

  it("takes a circle's box as its diameter square", () => {
    const box = minAreaBox(circle(150));
    expect(box.width).toBeCloseTo(300, 2);
    expect(box.height).toBeCloseTo(300, 2);
  });

  it('reports a near-axis-aligned rectangle as square to the canvas', () => {
    // Editors emit rotations of 0.02 degrees where the author drew none, and a
    // preview saying "0.02 degrees" makes a user hunt for a problem that is not
    // there.
    const box = minAreaBox(rotatedRect(600, 200, 0.2));
    expect(box.angle).toBe(0);
    expect(box.width).toBeCloseTo(600, 1);
    expect(box.height).toBeCloseTo(200, 1);
  });

  it('swaps the dimensions when it snaps a near-90-degree angle to zero', () => {
    // The trap: fold the angle into [0, 90) first and 89.8 becomes 0 while the
    // extents still describe the rotated orientation, so the part's width is
    // reported as its height.
    const box = minAreaBox(rotatedRect(600, 200, 89.8));
    expect(box.angle).toBe(0);
    expect(box.width).toBeCloseTo(200, 0);
    expect(box.height).toBeCloseTo(600, 0);
  });

  it('never reports an angle outside [0, 90)', () => {
    for (let degrees = -200; degrees <= 200; degrees += 3) {
      const box = minAreaBox(rotatedRect(431, 97, degrees));
      expect(box.angle).toBeGreaterThanOrEqual(0);
      expect(box.angle).toBeLessThan(90);
    }
  });

  it('gives a straight line no width, rather than its diagonal bounds', () => {
    // The axis-aligned fallback would call this a 100x100 part.
    const box = minAreaBox([p(0, 0), p(50, 50), p(100, 100)]);
    expect(Math.min(box.width, box.height)).toBeCloseTo(0, 9);
    expect(Math.max(box.width, box.height)).toBeCloseTo(Math.hypot(100, 100), 9);
    expect(isDegenerate(box)).toBe(true);
  });

  it('does not crash on empty or single-point input', () => {
    expect(minAreaBox([])).toEqual({ width: 0, height: 0, angle: 0 });
    expect(minAreaBox([p(5, 5)])).toEqual({ width: 0, height: 0, angle: 0 });
  });
});

describe('isDegenerate', () => {
  it('rejects a hairline that has enough area to pass on area alone', () => {
    // 200 x 0.05mm is 10mm². Area alone would let it through.
    expect(isDegenerate({ width: 200, height: 0.05, angle: 0 })).toBe(true);
  });

  it('rejects a dot too small to be any part', () => {
    expect(isDegenerate({ width: 0.9, height: 0.9, angle: 0 })).toBe(true);
  });

  it('keeps a small but real shape, leaving the call to the user', () => {
    expect(isDegenerate({ width: 20, height: 20, angle: 0 })).toBe(false);
    expect(isDegenerate({ width: 2, height: 2, angle: 0 })).toBe(false);
  });
});

describe('area and bounds', () => {
  it('measures a polygon regardless of winding', () => {
    const clockwise = [p(0, 0), p(10, 0), p(10, 20), p(0, 20)];
    expect(polygonArea(clockwise)).toBeCloseTo(200, 9);
    expect(polygonArea([...clockwise].reverse())).toBeCloseTo(200, 9);
  });

  it('signs area positive for clockwise winding in this y-down system', () => {
    expect(signedArea2([p(0, 0), p(10, 0), p(10, 10), p(0, 10)])).toBeGreaterThan(0);
  });

  it('bounds a point set, and an empty one at the origin', () => {
    expect(boundsOf([p(5, -3), p(-1, 4)])).toEqual({ x: -1, y: -3, width: 6, height: 7 });
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('pointInPolygon', () => {
  const square = [p(0, 0), p(100, 0), p(100, 100), p(0, 100)];

  it('accepts an interior point and rejects an exterior one', () => {
    expect(pointInPolygon(p(50, 50), square)).toBe(true);
    expect(pointInPolygon(p(150, 50), square)).toBe(false);
    expect(pointInPolygon(p(50, -1), square)).toBe(false);
  });

  it('handles a concave shape, where bounds alone would be wrong', () => {
    // An L. The notch is inside the bounding box and outside the polygon,
    // which is exactly the case that makes hole detection need more than
    // nested bounds.
    const ell = [p(0, 0), p(100, 0), p(100, 40), p(40, 40), p(40, 100), p(0, 100)];
    expect(pointInPolygon(p(20, 20), ell)).toBe(true);
    expect(pointInPolygon(p(80, 80), ell)).toBe(false);
  });
});
