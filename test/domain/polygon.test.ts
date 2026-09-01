import { describe, expect, it } from 'vitest';
import { clearance } from '../../src/domain/geometry';
import {
  boundsOf,
  convexHull,
  minAreaBox,
  type Point,
  pointInPolygon,
  polygonArea,
  polygonInRect,
  polygonSeparation,
  rotatePolygon,
  signedArea2,
  simplify,
  translatePolygon,
} from '../../src/domain/polygon';

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

/** The four corners of an axis-aligned rectangle, clockwise from the top-left. */
function rect(x: number, y: number, width: number, height: number): Point[] {
  return [p(x, y), p(x + width, y), p(x + width, y + height), p(x, y + height)];
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
  });

  it('does not crash on empty or single-point input', () => {
    expect(minAreaBox([])).toEqual({ width: 0, height: 0, angle: 0 });
    expect(minAreaBox([p(5, 5)])).toEqual({ width: 0, height: 0, angle: 0 });
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

describe('simplify', () => {
  it('sheds most of a flattened arc while keeping its shape within tolerance', () => {
    const arc = circle(150);
    const simplified = simplify(arc, 0.5);

    expect(simplified.length).toBeLessThan(arc.length / 4);
    // Every original vertex still sits within tolerance of the simplified ring,
    // which is the property that matters: the part is the same part.
    for (const point of arc) {
      expect(distanceToRing(point, simplified)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it('leaves a shape that is already minimal alone', () => {
    const square = rect(0, 0, 600, 400);
    expect(simplify(square, 0.5)).toEqual(square);
  });

  it('keeps a corner that a looser tolerance would shave off', () => {
    // The notch of an L is 60mm deep. It survives a 0.5mm tolerance and is the
    // whole difference between an L-shaped part and a rectangle.
    const ell = [p(0, 0), p(100, 0), p(100, 40), p(40, 40), p(40, 100), p(0, 100)];
    expect(simplify(ell, 0.5)).toHaveLength(6);
  });

  it('simplifies the same ring the same way whichever vertex it starts from', () => {
    // Douglas-Peucker pins its endpoints, so running it on a ring as though
    // vertex 0 were an endpoint would shave the shape asymmetrically around
    // whichever vertex happened to be stored first - and two copies of one part
    // would stop grouping into a quantity.
    const arc = circle(150, 120);
    const rotated = [...arc.slice(37), ...arc.slice(0, 37)];
    const fromStart = simplify(arc, 1);
    const fromElsewhere = simplify(rotated, 1);

    expect(fromElsewhere).toHaveLength(fromStart.length);
    expect(polygonArea(fromElsewhere)).toBeCloseTo(polygonArea(fromStart), 6);
  });

  it('never drops a ring below three points', () => {
    // A tolerance far larger than the shape. Deciding what to do with a
    // contour this small is `isDegenerate`'s job, not this one's.
    expect(simplify(circle(1, 64), 1000).length).toBeGreaterThanOrEqual(3);
  });

  it('passes a triangle and a non-positive tolerance straight through', () => {
    const triangle = [p(0, 0), p(10, 0), p(0, 10)];
    expect(simplify(triangle, 5)).toEqual(triangle);
    expect(simplify(rect(0, 0, 10, 10), 0)).toHaveLength(4);
  });
});

describe('rotatePolygon and translatePolygon', () => {
  it('turns clockwise for a positive angle, in this y-down system', () => {
    // Pinned on purpose: this is the direction `OrientedBox.angle` reports and
    // the one `Placement.angleDeg` will mean, and getting it backwards would
    // mirror every nested part rather than fail.
    const [turned] = rotatePolygon([p(10, 0)], 90);
    expect(turned?.x).toBeCloseTo(0, 9);
    expect(turned?.y).toBeCloseTo(10, 9);
  });

  it('preserves area', () => {
    const ell = [p(0, 0), p(100, 0), p(100, 40), p(40, 40), p(40, 100), p(0, 100)];
    expect(polygonArea(rotatePolygon(ell, 37))).toBeCloseTo(polygonArea(ell), 6);
  });

  it('returns to itself after four quarter turns', () => {
    const shape = rect(5, 7, 60, 20);
    let turned = shape;
    for (let i = 0; i < 4; i += 1) turned = rotatePolygon(turned, 90);
    for (let i = 0; i < shape.length; i += 1) {
      expect(turned[i]?.x).toBeCloseTo(shape[i]?.x ?? Number.NaN, 9);
      expect(turned[i]?.y).toBeCloseTo(shape[i]?.y ?? Number.NaN, 9);
    }
  });

  it('moves a polygon without reshaping it', () => {
    const moved = translatePolygon(rect(0, 0, 60, 20), 100, -5);
    expect(boundsOf(moved)).toEqual({ x: 100, y: -5, width: 60, height: 20 });
  });
});

describe('polygonSeparation', () => {
  it('measures the gap between two disjoint shapes', () => {
    expect(polygonSeparation(rect(0, 0, 100, 100), rect(103, 0, 100, 100))).toBeCloseTo(3, 9);
  });

  it('reports zero for shapes that touch', () => {
    expect(polygonSeparation(rect(0, 0, 100, 100), rect(100, 0, 100, 100))).toBeCloseTo(0, 9);
  });

  it('goes negative when two shapes overlap in a flush band', () => {
    // Two parts in adjacent columns, sharing top and bottom edges - the most
    // ordinary overlap on a cut sheet, and the one that catches a naive
    // implementation out. No vertex of either rectangle is strictly inside the
    // other and no edge pair properly crosses, so vertex sampling alone reports
    // these as comfortably disjoint.
    const gap = polygonSeparation(rect(0, 0, 100, 100), rect(95, 0, 100, 100));
    expect(gap).toBeLessThan(0);
    expect(-gap).toBeCloseTo(5, 9);
  });

  it('goes negative when two shapes overlap at a corner', () => {
    const gap = polygonSeparation(rect(0, 0, 100, 100), rect(96, 97, 100, 100));
    expect(gap).toBeLessThan(0);
    expect(-gap).toBeCloseTo(3, 9);
  });

  it('goes negative when one shape is entirely inside another', () => {
    // No edges cross at all here, so boundary distance alone would report a
    // comfortable 40mm gap between a part and the part swallowing it.
    expect(polygonSeparation(rect(0, 0, 100, 100), rect(40, 40, 20, 20))).toBeLessThan(0);
  });

  it('sees two concave shapes nested in each other as disjoint', () => {
    // The whole point of nesting: these two Ls interlock, so their bounding
    // boxes overlap heavily while the parts themselves clear each other. A
    // box-based check would reject this layout.
    const ell = [p(0, 0), p(100, 0), p(100, 40), p(40, 40), p(40, 100), p(0, 100)];
    const nested = translatePolygon(rotatePolygon(ell, 180), 145, 145);

    expect(polygonSeparation(ell, nested)).toBeGreaterThan(0);
    const boxes = [boundsOf(ell), boundsOf(nested)] as const;
    expect(boxes[0].x + boxes[0].width).toBeGreaterThan(boxes[1].x);
  });

  it('is Euclidean where clearance() is axis-of-separation, on purpose', () => {
    // These must not be reconciled. `clearance` takes the larger of the two
    // axis gaps because a guillotine separation is made by one edge-to-edge saw
    // cut and a cut has an axis; a router bit does not, so the real gap between
    // two nested parts is the diagonal one.
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const b = { x: 103, y: 104, width: 100, height: 100 };

    expect(clearance(a, b)).toBeCloseTo(4, 9);
    expect(polygonSeparation(rect(0, 0, 100, 100), rect(103, 104, 100, 100))).toBeCloseTo(5, 9);
  });

  it('treats an empty polygon as infinitely far away rather than overlapping', () => {
    expect(polygonSeparation([], rect(0, 0, 10, 10))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('polygonInRect', () => {
  const usable = { x: 10, y: 10, width: 100, height: 100 };

  it('accepts a polygon inside the rectangle', () => {
    expect(polygonInRect(rect(20, 20, 50, 50), usable)).toBe(true);
  });

  it('accepts a polygon flush against the edges', () => {
    expect(polygonInRect(rect(10, 10, 100, 100), usable)).toBe(true);
  });

  it('rejects a polygon that straddles one edge', () => {
    expect(polygonInRect(rect(80, 20, 50, 50), usable)).toBe(false);
    expect(polygonInRect(rect(20, 5, 50, 50), usable)).toBe(false);
  });

  it('accepts a part longer than the area it fits into, laid diagonally', () => {
    // A 130mm bar does not fit a 100x100 area along either axis, but across the
    // diagonal it does. This is what a nester buys and what a width/height
    // check cannot see.
    const turned = rotatePolygon(rect(0, 0, 130, 10), 45);
    const bounds = boundsOf(turned);
    const diagonal = translatePolygon(turned, usable.x - bounds.x, usable.y - bounds.y);

    expect(bounds.width).toBeGreaterThan(usable.width - 2);
    expect(polygonInRect(diagonal, usable)).toBe(true);
    // Nudged past the corner it no longer fits, so the pass above is a real fit
    // rather than a rectangle that was never tight.
    expect(polygonInRect(translatePolygon(diagonal, 2, 0), usable)).toBe(false);
  });
});

/** Shortest distance from a point to a closed ring's boundary. */
function distanceToRing(point: Point, ring: readonly Point[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    nearest = Math.min(nearest, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return nearest;
}
