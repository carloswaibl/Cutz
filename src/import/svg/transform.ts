/**
 * SVG `transform` attributes: parsing, composition, and the one property that
 * decides whether a bounding box is honest.
 *
 * A part drawn inside three nested groups, each with its own transform, sits
 * nowhere near where its own coordinates say. Composing those transforms down
 * to the leaf is not optional detail - it is the difference between importing a
 * drawing and importing a scattering of shapes at arbitrary sizes.
 *
 * This module only *parses and composes*. Applying a matrix to path data is
 * `svg-pathdata`'s job in `flatten.ts`, and doing it twice in two places is how
 * the two end up disagreeing about the order of multiplication.
 *
 * Matrices are the SVG 2x3 affine `[a b c d e f]`, standing for
 *
 *     | a  c  e |
 *     | b  d  f |
 *     | 0  0  1 |
 *
 * which is the order `svg-pathdata`'s `.matrix(a, b, c, d, e, f)` expects, so
 * the fields hand straight over with no transposition step to get wrong.
 */

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * `outer` applied after `inner`, i.e. the matrix for a child whose parent
 * carries `outer` and which carries `inner` itself.
 *
 * SVG composes transforms left to right within an attribute and outermost to
 * innermost down the tree, and both reduce to this: the point goes through
 * `inner` first.
 */
export function multiply(outer: Matrix, inner: Matrix): Matrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function applyMatrix(m: Matrix, p: { x: number; y: number }): { x: number; y: number } {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export function translation(tx: number, ty: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scaling(sx: number, sy: number): Matrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

// --- Parsing --------------------------------------------------------------

/**
 * One `name(args)` clause. Names outside this set are not silently ignored -
 * see `parseTransform`.
 */
const TRANSFORM_CLAUSE = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

/** Numbers as SVG writes them, including `1e-5`, `.5` and `-.5`. */
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * A `transform` attribute as a single matrix, or `null` when any part of it was
 * not understood.
 *
 * `null` rather than identity, deliberately. Identity is a *plausible* answer -
 * the shape still imports, at a size that looks reasonable, in the wrong place.
 * A caller that gets `null` skips the subtree and says so, which is the only
 * honest option: this is untrusted input, and quietly guessing where somebody's
 * part goes is exactly the failure this milestone exists to avoid.
 *
 * An empty or whitespace-only attribute is identity, not a failure - that is
 * what `transform=""` means.
 */
export function parseTransform(attribute: string): Matrix | null {
  let result = IDENTITY;
  let consumed = 0;

  TRANSFORM_CLAUSE.lastIndex = 0;
  let clause = TRANSFORM_CLAUSE.exec(attribute);
  while (clause) {
    const name = clause[1];
    const argsText = clause[2];
    if (name === undefined || argsText === undefined) return null;

    // Pulling the numbers out is not enough on its own: `translate(1, abc)`
    // would yield `[1]` and read as a valid one-argument translate. Whatever
    // is left after the numbers must be separators and nothing else.
    if (/[^\s,]/.test(argsText.replace(NUMBER, ''))) return null;

    const args = argsText.match(NUMBER)?.map(Number) ?? [];
    if (args.some((n) => !Number.isFinite(n))) return null;

    const step = clauseMatrix(name, args);
    if (!step) return null;

    result = multiply(result, step);
    consumed += clause[0].length;
    clause = TRANSFORM_CLAUSE.exec(attribute);
  }

  // Everything that was not a clause must be separator noise. Anything else -
  // `translate(10,0) garbage` - means the attribute was not what we think it
  // is, and taking the half we understood would place the shape confidently
  // and wrongly.
  const leftovers = attribute.replace(TRANSFORM_CLAUSE, '');
  if (consumed === 0 && attribute.trim() !== '') return null;
  if (leftovers.trim() !== '') return null;

  return result;
}

function clauseMatrix(name: string, args: readonly number[]): Matrix | null {
  switch (name) {
    case 'matrix': {
      if (args.length !== 6) return null;
      const [a, b, c, d, e, f] = args;
      // Destructuring under `noUncheckedIndexedAccess` gives `number | undefined`
      // even after the length check, so each one is narrowed rather than cast.
      if (
        a === undefined ||
        b === undefined ||
        c === undefined ||
        d === undefined ||
        e === undefined ||
        f === undefined
      ) {
        return null;
      }
      return { a, b, c, d, e, f };
    }
    case 'translate': {
      const tx = args[0];
      if (tx === undefined || args.length > 2) return null;
      // A one-argument translate means "and zero in y", per the spec.
      return translation(tx, args[1] ?? 0);
    }
    case 'scale': {
      const sx = args[0];
      if (sx === undefined || args.length > 2) return null;
      // A one-argument scale is uniform, which is not the same as "and 1 in y".
      return scaling(sx, args[1] ?? sx);
    }
    case 'rotate': {
      const degrees = args[0];
      if (degrees === undefined || (args.length !== 1 && args.length !== 3)) return null;
      const radians = (degrees * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const rotation: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      const cx = args[1];
      const cy = args[2];
      if (cx === undefined || cy === undefined) return rotation;
      // `rotate(deg cx cy)` is a rotation about a point: move the point to the
      // origin, rotate, move it back.
      return multiply(multiply(translation(cx, cy), rotation), translation(-cx, -cy));
    }
    case 'skewX': {
      const degrees = args[0];
      if (degrees === undefined || args.length !== 1) return null;
      return { a: 1, b: 0, c: Math.tan((degrees * Math.PI) / 180), d: 1, e: 0, f: 0 };
    }
    case 'skewY': {
      const degrees = args[0];
      if (degrees === undefined || args.length !== 1) return null;
      return { a: 1, b: Math.tan((degrees * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
    }
    default:
      return null;
  }
}

// --- Shear ----------------------------------------------------------------

/**
 * How far from perpendicular the two basis vectors may drift before a shape is
 * called sheared.
 *
 * A ratio, not an absolute: the dot product of the basis vectors scales with
 * the transform, so a drawing scaled by 1000 would trip any fixed threshold
 * on float noise alone. 1e-6 of the product of the two lengths is roughly a
 * ten-thousandth of a degree out of square.
 */
const SHEAR_TOLERANCE = 1e-6;

/**
 * True when this transform does not map a rectangle to a rectangle.
 *
 * This is the one property of a composed transform that the bounding box cares
 * about. Translation, rotation, uniform scale and even non-uniform axis-aligned
 * scale all take a rectangle to a rectangle, so the oriented box around the
 * result is exactly the part. A shear takes it to a parallelogram, whose
 * smallest enclosing rectangle is strictly larger than the shape - so the part
 * imports oversized, and there is nothing to be done about it except say so.
 *
 * The test is whether the transformed x and y basis vectors are still
 * perpendicular. A mirror (negative determinant) is not shear and is not
 * flagged: it maps rectangles to rectangles perfectly well.
 */
export function isSheared(m: Matrix): boolean {
  const xBasis = Math.hypot(m.a, m.b);
  const yBasis = Math.hypot(m.c, m.d);
  // A collapsed transform has no shape left to shear.
  if (xBasis === 0 || yBasis === 0) return false;
  const dot = m.a * m.c + m.b * m.d;
  return Math.abs(dot) > SHEAR_TOLERANCE * xBasis * yBasis;
}
