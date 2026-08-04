import { describe, expect, it } from 'vitest';
import {
  approxEq,
  approxGte,
  approxLte,
  area,
  bottom,
  clearance,
  containsRect,
  EPSILON,
  fits,
  isEmpty,
  overlaps,
  type Rect,
  right,
} from '../../src/domain/geometry';

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

describe('tolerant comparison', () => {
  it('treats accumulated float noise as equality', () => {
    // The packer walks across a sheet adding part widths and kerfs, so the
    // right edge of the last slot is a sum, not a literal. It misses the
    // sheet edge by ~1e-13mm, which is not a woodworking fact.
    let walked = 0;
    for (let i = 0; i < 10; i += 1) walked += 3.2;
    expect(walked).not.toBe(32);
    expect(approxEq(walked, 32)).toBe(true);
    expect(approxLte(walked, 32)).toBe(true);
  });

  it('does not treat a real difference as equality', () => {
    expect(approxEq(600, 600.001)).toBe(false);
    expect(approxLte(600.001, 600)).toBe(false);
    expect(approxGte(599.999, 600)).toBe(false);
  });

  it('admits values just outside the bound', () => {
    expect(approxLte(600 + EPSILON / 2, 600)).toBe(true);
    expect(approxGte(600 - EPSILON / 2, 600)).toBe(true);
  });
});

describe('basic measures', () => {
  it('computes edges and area', () => {
    const r = rect(10, 20, 100, 50);
    expect(right(r)).toBe(110);
    expect(bottom(r)).toBe(70);
    expect(area(r)).toBe(5000);
  });

  it('treats a zero-extent rectangle as empty', () => {
    expect(isEmpty(rect(0, 0, 0, 100))).toBe(true);
    expect(isEmpty(rect(0, 0, 100, 0))).toBe(true);
    expect(isEmpty(rect(0, 0, EPSILON / 2, 100))).toBe(true);
    expect(isEmpty(rect(0, 0, 1, 1))).toBe(false);
  });
});

describe('containsRect', () => {
  const sheet = rect(10, 10, 1200, 2420);

  it('accepts a rectangle strictly inside', () => {
    expect(containsRect(sheet, rect(100, 100, 200, 300))).toBe(true);
  });

  it('accepts a rectangle sharing edges with the container', () => {
    expect(containsRect(sheet, rect(10, 10, 1200, 2420))).toBe(true);
  });

  it('rejects a rectangle crossing any edge', () => {
    expect(containsRect(sheet, rect(9, 10, 100, 100))).toBe(false);
    expect(containsRect(sheet, rect(10, 9, 100, 100))).toBe(false);
    expect(containsRect(sheet, rect(1200, 10, 100, 100))).toBe(false);
    expect(containsRect(sheet, rect(10, 2400, 100, 100))).toBe(false);
  });
});

describe('fits', () => {
  const slot = rect(0, 0, 600, 400);

  it('accepts an exact fit', () => {
    expect(fits(600, 400, slot)).toBe(true);
  });

  it('accepts a fit that misses only by float noise', () => {
    expect(fits(600 + EPSILON / 2, 400, slot)).toBe(true);
  });

  it('rejects a footprint larger in either axis', () => {
    expect(fits(601, 400, slot)).toBe(false);
    expect(fits(600, 401, slot)).toBe(false);
  });

  it('ignores the slot position', () => {
    expect(fits(600, 400, rect(999, 999, 600, 400))).toBe(true);
  });
});

describe('clearance', () => {
  it('reports the gap between side-by-side rectangles', () => {
    // Two parts in a row with a 3mm saw kerf between them.
    expect(clearance(rect(0, 0, 100, 100), rect(103, 0, 100, 100))).toBeCloseTo(3);
  });

  it('reports the gap between stacked rectangles', () => {
    expect(clearance(rect(0, 0, 100, 100), rect(0, 103, 100, 100))).toBeCloseTo(3);
  });

  it('is symmetric', () => {
    const a = rect(0, 0, 100, 100);
    const b = rect(103, 0, 100, 100);
    expect(clearance(a, b)).toBeCloseTo(clearance(b, a));
  });

  it('takes the larger axis gap, because clearing one axis is enough', () => {
    // Far apart horizontally, vertically overlapping. No horizontal cut is
    // needed between them at all, so the vertical overlap is irrelevant.
    const a = rect(0, 0, 100, 500);
    const b = rect(400, 100, 100, 500);
    expect(clearance(a, b)).toBeCloseTo(300);
  });

  it('is zero for touching rectangles', () => {
    expect(clearance(rect(0, 0, 100, 100), rect(100, 0, 100, 100))).toBeCloseTo(0);
  });

  it('is negative for overlapping rectangles', () => {
    expect(clearance(rect(0, 0, 100, 100), rect(90, 90, 100, 100))).toBeLessThan(0);
    expect(clearance(rect(0, 0, 100, 100), rect(0, 0, 100, 100))).toBeLessThan(0);
  });

  it('distinguishes a legal kerf gap from a starved one', () => {
    const kerf = 3;
    const a = rect(0, 0, 100, 100);
    expect(clearance(a, rect(103, 0, 100, 100))).toBeGreaterThanOrEqual(kerf);
    expect(clearance(a, rect(102, 0, 100, 100))).toBeLessThan(kerf);
  });
});

describe('overlaps', () => {
  it('is true only for shared positive area', () => {
    expect(overlaps(rect(0, 0, 100, 100), rect(50, 50, 100, 100))).toBe(true);
    expect(overlaps(rect(0, 0, 100, 100), rect(100, 0, 100, 100))).toBe(false);
    expect(overlaps(rect(0, 0, 100, 100), rect(200, 200, 100, 100))).toBe(false);
  });

  it('does not count a shared edge as an overlap', () => {
    expect(overlaps(rect(0, 0, 100, 100), rect(0, 100, 100, 100))).toBe(false);
  });
});
