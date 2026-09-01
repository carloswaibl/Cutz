// @vitest-environment jsdom

/**
 * The basic shapes as path data - §4.1.
 *
 * Sizes are asserted through the whole flatten pipeline rather than by reading
 * the emitted `d` string, because the `d` is an intermediate nobody looks at and
 * the size is the thing a part is wrong about.
 */

import { describe, expect, it } from 'vitest';
import { minAreaBox, type Point } from '../../src/domain/polygon';
import { FLATTEN_TOLERANCE_MM, flattenPath } from '../../src/import/svg/flatten';
import { isShapeElement, shapeToPathData } from '../../src/import/svg/shapes';
import { IDENTITY } from '../../src/import/svg/transform';

function element(markup: string): Element {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
    'image/svg+xml',
  );
  const first = doc.documentElement.children[0];
  if (!first) throw new Error('no element in test markup');
  return first;
}

/** The oriented box of a shape, taken the way the importer takes it. */
function boxOf(markup: string) {
  const d = shapeToPathData(element(markup));
  if (d === null) throw new Error('shape was unreadable');
  const subpaths = flattenPath(d, IDENTITY);
  if (!subpaths) throw new Error('path data was unreadable');
  const points: Point[] = subpaths.flatMap((subpath) => subpath.points);
  return minAreaBox(points);
}

/**
 * A flattened curve is a polygon *inscribed* in it, so a curved shape always
 * measures a shade under its true size - by at most the flattening tolerance,
 * and never over. That is the contract `FLATTEN_TOLERANCE_MM` states, and it is
 * worth asserting directly rather than hiding behind a precision digit chosen
 * to make the number pass.
 */
function expectFlattenedExtent(actual: number, exact: number): void {
  expect(actual).toBeLessThanOrEqual(exact);
  expect(actual).toBeGreaterThan(exact - FLATTEN_TOLERANCE_MM);
}

describe('isShapeElement', () => {
  it.each(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line'])(
    'accepts %s',
    (name) => expect(isShapeElement(name)).toBe(true),
  );

  it.each(['g', 'text', 'image', 'use', 'svg'])('rejects %s', (name) =>
    expect(isShapeElement(name)).toBe(false),
  );
});

describe('shapeToPathData', () => {
  it('measures a rect at its stated size', () => {
    const box = boxOf('<rect x="10" y="20" width="600" height="300"/>');
    expect(box.width).toBeCloseTo(600, 6);
    expect(box.height).toBeCloseTo(300, 6);
    expect(box.angle).toBe(0);
  });

  it("takes a rounded rect's full size, because the radius is inside the cut", () => {
    const box = boxOf('<rect width="600" height="300" rx="20" ry="20"/>');
    expectFlattenedExtent(box.width, 600);
    expectFlattenedExtent(box.height, 300);
  });

  it('implies the other radius when only one is given', () => {
    const box = boxOf('<rect width="600" height="300" rx="20"/>');
    expectFlattenedExtent(box.width, 600);
    expectFlattenedExtent(box.height, 300);
  });

  it('clamps an oversized radius to half the side rather than inverting the corners', () => {
    const box = boxOf('<rect width="100" height="60" rx="9999"/>');
    expectFlattenedExtent(box.width, 100);
    expectFlattenedExtent(box.height, 60);
  });

  it("makes a circle's box its diameter square", () => {
    const box = boxOf('<circle cx="50" cy="50" r="40"/>');
    expectFlattenedExtent(box.width, 80);
    expectFlattenedExtent(box.height, 80);
  });

  it("makes an ellipse's box its two diameters", () => {
    const box = boxOf('<ellipse cx="0" cy="0" rx="30" ry="10"/>');
    expectFlattenedExtent(Math.max(box.width, box.height), 60);
    expectFlattenedExtent(Math.min(box.width, box.height), 20);
  });

  it('closes a polygon by definition', () => {
    const d = shapeToPathData(element('<polygon points="0,0 100,0 100,50 0,50"/>'));
    expect(d).toMatch(/z$/i);
  });

  it('leaves a polyline open', () => {
    const d = shapeToPathData(element('<polyline points="0,0 100,0 100,50"/>'));
    expect(d).not.toMatch(/z$/i);
  });

  it('accepts comma or space separated points', () => {
    const box = boxOf('<polygon points="0 0, 100 0, 100 50, 0 50"/>');
    expect(box.width).toBeCloseTo(100, 6);
    expect(box.height).toBeCloseTo(50, 6);
  });

  it('turns a line into a two-point polyline for the degenerate test to reject', () => {
    // One code path instead of two, and it lands in §4.3's counted fold, which
    // is what a user wants for construction lines and registration marks.
    const d = shapeToPathData(element('<line x1="0" y1="0" x2="100" y2="100"/>'));
    expect(d).not.toBeNull();
    const box = boxOf('<line x1="0" y1="0" x2="100" y2="100"/>');
    expect(Math.min(box.width, box.height)).toBeCloseTo(0, 6);
  });

  it('passes a path through untouched', () => {
    expect(shapeToPathData(element('<path d="M0 0 L10 0 L10 10 Z"/>'))).toBe('M0 0 L10 0 L10 10 Z');
  });

  describe('returns null rather than a plausible wrong answer', () => {
    it.each([
      ['a path with no d', '<path/>'],
      ['a path with an empty d', '<path d="  "/>'],
      ['a rect with no width', '<rect height="10"/>'],
      ['a rect with zero height', '<rect width="10" height="0"/>'],
      ['a circle with no radius', '<circle cx="5" cy="5"/>'],
      ['an ellipse missing ry', '<ellipse rx="5"/>'],
      ['points with an odd coordinate count', '<polygon points="0,0 10,0 10"/>'],
      ['points with too few points', '<polygon points="0,0"/>'],
      ['unreadable points', '<polygon points="0,0 ten,0 10,10"/>'],
      ['an element that is not a shape', '<g/>'],
    ])('%s', (_name, markup) => {
      expect(shapeToPathData(element(markup))).toBeNull();
    });

    it('a geometry attribute carrying a unit it cannot convert', () => {
      // `<rect width="10mm">` is legal SVG 1.1, and there is no honest way to
      // read it here - converting needs the mm-per-user-unit factor only the
      // viewport knows. Reporting it beats importing 10mm as ten user units.
      expect(shapeToPathData(element('<rect width="10mm" height="10mm"/>'))).toBeNull();
    });

    it('but accepts px, which *is* the user unit', () => {
      const box = boxOf('<rect width="600px" height="300px"/>');
      expect(box.width).toBeCloseTo(600, 6);
    });
  });
});
