import { describe, expect, it } from 'vitest';
import {
  applyMatrix,
  IDENTITY,
  isSheared,
  type Matrix,
  multiply,
  parseTransform,
} from '../../src/import/svg/transform';

/** `parseTransform`, asserting it understood the attribute. */
function parsed(attribute: string): Matrix {
  const matrix = parseTransform(attribute);
  if (!matrix) throw new Error(`expected to parse: ${attribute}`);
  return matrix;
}

function expectMatrix(actual: Matrix, expected: Matrix, precision = 9): void {
  expect(actual.a).toBeCloseTo(expected.a, precision);
  expect(actual.b).toBeCloseTo(expected.b, precision);
  expect(actual.c).toBeCloseTo(expected.c, precision);
  expect(actual.d).toBeCloseTo(expected.d, precision);
  expect(actual.e).toBeCloseTo(expected.e, precision);
  expect(actual.f).toBeCloseTo(expected.f, precision);
}

describe('parseTransform', () => {
  it('reads an empty attribute as identity', () => {
    expect(parseTransform('')).toEqual(IDENTITY);
    expect(parseTransform('   ')).toEqual(IDENTITY);
  });

  it('reads every transform function', () => {
    expectMatrix(parsed('matrix(1,2,3,4,5,6)'), { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    expectMatrix(parsed('translate(10,20)'), { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
    expectMatrix(parsed('scale(2,3)'), { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
    expectMatrix(parsed('rotate(90)'), { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 });
    expectMatrix(parsed('skewX(45)'), { a: 1, b: 0, c: 1, d: 1, e: 0, f: 0 });
    expectMatrix(parsed('skewY(45)'), { a: 1, b: 1, c: 0, d: 1, e: 0, f: 0 });
  });

  it('treats a one-argument translate as zero in y, and a one-argument scale as uniform', () => {
    // These two defaults differ, which is the easy mistake: `scale(2)` is not
    // "2 in x and 1 in y", it is 2 in both.
    expectMatrix(parsed('translate(10)'), { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 });
    expectMatrix(parsed('scale(2)'), { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
  });

  it('rotates about a given centre', () => {
    // rotate(90 100 100) must hold (100,100) still.
    const m = parsed('rotate(90 100 100)');
    const fixed = applyMatrix(m, { x: 100, y: 100 });
    expect(fixed.x).toBeCloseTo(100, 9);
    expect(fixed.y).toBeCloseTo(100, 9);

    // and carry (200,100) a quarter turn round it, clockwise on screen.
    const moved = applyMatrix(m, { x: 200, y: 100 });
    expect(moved.x).toBeCloseTo(100, 9);
    expect(moved.y).toBeCloseTo(200, 9);
  });

  it('accepts the separator variants real files use', () => {
    const expected = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 };
    expectMatrix(parsed('translate(10,20)'), expected);
    expectMatrix(parsed('translate(10 20)'), expected);
    expectMatrix(parsed('translate( 10 , 20 )'), expected);
    expectMatrix(parsed('translate  (10,20)'), expected);
    expectMatrix(parsed('\n  translate(10,20)\n'), expected);
  });

  it('accepts the number forms real files use', () => {
    expectMatrix(parsed('translate(-.5,+1.5)'), { a: 1, b: 0, c: 0, d: 1, e: -0.5, f: 1.5 });
    expectMatrix(parsed('scale(1e3)'), { a: 1000, b: 0, c: 0, d: 1000, e: 0, f: 0 });
    expectMatrix(parsed('translate(1.5e-2,0)'), { a: 1, b: 0, c: 0, d: 1, e: 0.015, f: 0 });
  });

  it('composes a list left to right, applying the rightmost first', () => {
    // translate(100,0) scale(2) takes (10,0) to (120,0), not to (220,0).
    const m = parsed('translate(100,0) scale(2)');
    const moved = applyMatrix(m, { x: 10, y: 0 });
    expect(moved.x).toBeCloseTo(120, 9);
    expect(moved.y).toBeCloseTo(0, 9);
  });

  it('is order-sensitive, the way the spec is', () => {
    const a = applyMatrix(parsed('translate(100,0) scale(2)'), { x: 10, y: 0 });
    const b = applyMatrix(parsed('scale(2) translate(100,0)'), { x: 10, y: 0 });
    expect(a.x).toBeCloseTo(120, 9);
    expect(b.x).toBeCloseTo(220, 9);
  });

  it('refuses an attribute it does not fully understand, rather than guessing', () => {
    // Identity would be a plausible answer: the shape still imports, at a
    // believable size, in the wrong place. `null` makes the caller say so.
    expect(parseTransform('rubbish')).toBeNull();
    expect(parseTransform('translate(10,0) rubbish')).toBeNull();
    expect(parseTransform('wobble(10)')).toBeNull();
    expect(parseTransform('matrix(1,0,0,1,0)')).toBeNull();
    expect(parseTransform('rotate(45,10)')).toBeNull();
    expect(parseTransform('translate(1, abc)')).toBeNull();
    expect(parseTransform('translate(')).toBeNull();
    expect(parseTransform('skewX(10,20)')).toBeNull();
  });
});

describe('multiply', () => {
  it('leaves a matrix alone when composed with identity', () => {
    const m: Matrix = { a: 2, b: 3, c: 4, d: 5, e: 6, f: 7 };
    expectMatrix(multiply(IDENTITY, m), m);
    expectMatrix(multiply(m, IDENTITY), m);
  });

  it('applies the inner transform first, matching the nesting in a document', () => {
    // A group scaled 2x containing a shape translated by 10: the shape's own
    // translate happens in its own coordinates, then the group scales it.
    const composed = multiply(parsed('scale(2)'), parsed('translate(10,0)'));
    expect(applyMatrix(composed, { x: 0, y: 0 }).x).toBeCloseTo(20, 9);
  });
});

describe('isSheared', () => {
  it('flags a skew', () => {
    expect(isSheared(parsed('skewX(20)'))).toBe(true);
    expect(isSheared(parsed('skewY(20)'))).toBe(true);
    expect(isSheared(parsed('matrix(1,0,0.4,1,0,0)'))).toBe(true);
  });

  it('does not flag transforms that keep a rectangle a rectangle', () => {
    expect(isSheared(IDENTITY)).toBe(false);
    expect(isSheared(parsed('translate(500,300)'))).toBe(false);
    expect(isSheared(parsed('rotate(30)'))).toBe(false);
    expect(isSheared(parsed('scale(2,1)'))).toBe(false);
    expect(isSheared(parsed('rotate(30) scale(3,7) translate(20,20)'))).toBe(false);
  });

  it('does not mistake a large uniform scale for shear', () => {
    // The dot product of the basis vectors grows with the square of the scale,
    // so a fixed threshold would trip on float noise alone here.
    expect(isSheared(parsed('scale(1000) rotate(30)'))).toBe(false);
    expect(isSheared(parsed('scale(0.001) rotate(30)'))).toBe(false);
  });

  it('does not flag a mirror, which maps rectangles to rectangles perfectly well', () => {
    expect(isSheared(parsed('scale(-1,1)'))).toBe(false);
    expect(isSheared(parsed('scale(1,-1) rotate(30)'))).toBe(false);
  });

  it('has nothing to say about a collapsed transform', () => {
    expect(isSheared(parsed('scale(0,0)'))).toBe(false);
  });
});
