/**
 * The root `<svg>` element's three scale-bearing attributes, turned into one
 * matrix from user units to millimetres - and an honest account of where that
 * matrix came from.
 *
 * This is where an importer produces a plausible, wrong answer. Every other
 * failure in this milestone is visible: a skipped element is missing, an open
 * path is reported, a sheared box is flagged. A wrong scale produces a complete
 * parts list of believable numbers, and the error surfaces when a sheet has
 * already been cut. That is why the units policy says *prompt, do not guess*,
 * and why `ScaleSource` travels alongside the matrix rather than being thrown
 * away once the arithmetic is done.
 *
 * `inkscape:document-units` and the `sodipodi:namedview` hints are deliberately
 * not consulted. They describe the editor's ruler, not the document, and a file
 * whose ruler says inches and whose width says `210mm` is 210mm.
 */

import { sliceAspect } from '../errors';
import type { ImportWarning, ScaleSource } from '../types';
import { type Matrix, multiply, scaling } from './transform';

export interface Viewport {
  /** User units to millimetres. Everything downstream flattens through this. */
  matrix: Matrix;
  scale: ScaleSource;
  /**
   * How wide and tall the drawing is in mm, for the preview's "drawing is ___
   * wide" control. Null only when `scale.kind` is `none`, where the numbers
   * would be meaningless - there is nothing to be off by a factor of.
   */
  drawingWidthMm: number | null;
  drawingHeightMm: number | null;
  warnings: ImportWarning[];
}

/**
 * Millimetres per unit for every absolute unit CSS defines.
 *
 * `px` is absent on purpose even though it has a fixed definition of 1/96in.
 * It is handled separately because a px-scaled document is an *assumption*, not
 * a declaration - Inkscape before 0.92 wrote 90dpi files and they are still in
 * the wild - and folding it in here would erase the distinction the whole
 * module exists to preserve.
 */
const MM_PER_ABSOLUTE_UNIT: Readonly<Record<string, number>> = {
  mm: 1,
  cm: 10,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  // A quarter-millimetre. Rare, but it costs one line to not mis-scale by 4x.
  q: 0.25,
};

/** The spec's px, 1/96 of an inch. */
const MM_PER_PX = 25.4 / 96;

// --- Attribute parsing ----------------------------------------------------

interface SvgLength {
  value: number;
  /** Lower-cased, empty string when the number carried no unit. */
  unit: string;
}

const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/;

/**
 * A `width` or `height` attribute as a number and a unit.
 *
 * Null on anything that is not a single number with an optional unit, including
 * a calc() expression or an empty attribute. A caller that gets null has no
 * dimension, which is a case §5.1 already has an answer for.
 */
export function parseSvgLength(text: string | null): SvgLength | null {
  if (text === null) return null;
  const match = LENGTH.exec(text);
  const value = match?.[1];
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return { value: parsed, unit: (match?.[2] ?? '').toLowerCase() };
}

export interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * A `viewBox` attribute, or null when it is absent or unusable.
 *
 * A zero or negative extent is treated as absent rather than as an error: the
 * spec says such a viewBox disables rendering entirely, and a file nobody can
 * see is not a file we should invent a scale for.
 */
export function parseViewBox(text: string | null): ViewBox | null {
  if (text === null) return null;
  const parts = text
    .trim()
    .split(/[\s,]+/)
    .filter((token) => token !== '');
  if (parts.length !== 4) return null;
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  const [minX, minY, width, height] = numbers;
  if (minX === undefined || minY === undefined || width === undefined || height === undefined) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return { minX, minY, width, height };
}

interface AspectRatio {
  /** Null means `none`: scale the two axes independently. */
  alignX: number | null;
  alignY: number;
  slice: boolean;
}

const DEFAULT_ASPECT: AspectRatio = { alignX: 0.5, alignY: 0.5, slice: false };

/**
 * A `preserveAspectRatio` attribute.
 *
 * The default matters more than the attribute does: `xMidYMid meet` applies to
 * every file that omits it, and it is a *uniform* scale of `min(sx, sy)` plus a
 * centring translate. Taking `sx` alone - the obvious shortcut - silently
 * stretches every part in one axis and still looks like a drawing, which is
 * exactly the failure mode this module exists to prevent.
 *
 * An unreadable value falls back to the default rather than failing. Unlike a
 * transform, where a wrong answer moves a part somewhere arbitrary, the default
 * here is what the file would have got by saying nothing at all.
 */
export function parseAspectRatio(text: string | null): AspectRatio {
  if (text === null) return DEFAULT_ASPECT;
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  // `defer` is only meaningful on an `<image>`, and is ignored on `<svg>`.
  const meaningful = tokens[0] === 'defer' ? tokens.slice(1) : tokens;
  const align = meaningful[0];
  if (align === undefined) return DEFAULT_ASPECT;
  const slice = meaningful[1] === 'slice';
  if (align === 'none') return { alignX: null, alignY: 0, slice };

  const fractions: Readonly<Record<string, number>> = { min: 0, mid: 0.5, max: 1 };
  const parts = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align);
  const x = fractions[(parts?.[1] ?? '').toLowerCase()];
  const y = fractions[(parts?.[2] ?? '').toLowerCase()];
  if (x === undefined || y === undefined) return DEFAULT_ASPECT;
  return { alignX: x, alignY: y, slice };
}

// --- Resolution -----------------------------------------------------------

/** How a dimension attribute contributes to the scale, if at all. */
type LengthKind = 'declared' | 'assumed-px' | null;

function lengthKind(length: SvgLength | null): LengthKind {
  if (!length) return null;
  if (MM_PER_ABSOLUTE_UNIT[length.unit] !== undefined) return 'declared';
  // Unitless means user units, which are px by definition.
  if (length.unit === '' || length.unit === 'px') return 'assumed-px';
  // A percentage, an em, or something we do not know. None of them describe a
  // physical size without a containing block, and there is no containing block.
  return null;
}

/** The length in mm, or null when it does not describe a physical size. */
function lengthMm(length: SvgLength | null): number | null {
  if (!length) return null;
  const factor = MM_PER_ABSOLUTE_UNIT[length.unit];
  if (factor !== undefined) return length.value * factor;
  if (length.unit === '' || length.unit === 'px') return length.value * MM_PER_PX;
  return null;
}

/**
 * Resolve the root element's scale and placement.
 *
 * `overrideMmPerUnit` is the preview's scale control, and it rescales whatever
 * was derived rather than replacing it. That matters for the two cases where
 * the derived matrix carries structure worth keeping: a non-zero viewBox origin
 * and an anisotropic `preserveAspectRatio="none"`. Replacing the matrix with a
 * plain uniform scale would quietly discard both.
 *
 * When nothing at all can be derived the matrix is the identity and `scale` is
 * `none`. Parts still come back, at user-unit sizes, because their *relative*
 * sizes are still informative and the preview shows them - what it will not do
 * is let anything be committed until a scale exists.
 */
export function resolveViewport(root: Element, overrideMmPerUnit?: number): Viewport {
  const warnings: ImportWarning[] = [];

  const width = parseSvgLength(root.getAttribute('width'));
  const height = parseSvgLength(root.getAttribute('height'));
  const viewBox = parseViewBox(root.getAttribute('viewBox'));

  const widthMm = lengthMm(width);
  const heightMm = lengthMm(height);
  // Width drives the scale, per §5.1. Height is the fallback for the unusual
  // file that declares one and not the other.
  const kind = lengthKind(width) ?? lengthKind(height);
  const unit = (lengthKind(width) ? width?.unit : height?.unit) ?? '';

  let sx = 1;
  let sy = 1;
  let tx = 0;
  let ty = 0;
  let derived: LengthKind = null;

  if (viewBox) {
    if (widthMm !== null && heightMm !== null) {
      sx = widthMm / viewBox.width;
      sy = heightMm / viewBox.height;

      const aspect = parseAspectRatio(root.getAttribute('preserveAspectRatio'));
      if (aspect.slice) {
        // Slice crops the drawing to fill its frame. Honouring it would mean
        // deciding whether the clipped-away geometry is still a part, and both
        // answers are wrong in some file - so it is fitted instead and said out
        // loud, which is the one option that cannot silently lose a part.
        warnings.push(sliceAspect());
      }
      if (aspect.alignX !== null) {
        const uniform = Math.min(sx, sy);
        tx = (widthMm - viewBox.width * uniform) * aspect.alignX;
        ty = (heightMm - viewBox.height * uniform) * aspect.alignY;
        sx = uniform;
        sy = uniform;
      }
      derived = kind;
    } else if (widthMm !== null) {
      sx = widthMm / viewBox.width;
      sy = sx;
      derived = kind;
    } else if (heightMm !== null) {
      sy = heightMm / viewBox.height;
      sx = sy;
      derived = kind;
    }
    // A viewBox always shifts its origin to the top-left of the viewport.
    tx -= viewBox.minX * sx;
    ty -= viewBox.minY * sy;
  } else if (kind !== null) {
    // No viewBox: user units are whatever the dimensions were declared in.
    sx = MM_PER_ABSOLUTE_UNIT[unit] ?? MM_PER_PX;
    sy = sx;
    derived = kind;
  }

  // A degenerate scale is no scale. Reaching this needs a zero-width document,
  // which is a file nobody can see rather than one we should guess about.
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) {
    sx = 1;
    sy = 1;
    tx = 0;
    ty = 0;
    derived = null;
  }

  // Kept even when the scale is unknown: the placeholder is a unit scale, so
  // what survives is the viewBox origin shift, and relative geometry stays
  // right for a preview the user is about to supply the missing factor to.
  let matrix: Matrix = { a: sx, b: 0, c: 0, d: sy, e: tx, f: ty };

  let scale: ScaleSource;
  if (
    overrideMmPerUnit !== undefined &&
    Number.isFinite(overrideMmPerUnit) &&
    overrideMmPerUnit > 0
  ) {
    // Rescale rather than replace, so the viewBox origin and any deliberate
    // anisotropy survive the correction.
    matrix = multiply(scaling(overrideMmPerUnit / sx, overrideMmPerUnit / sx), matrix);
    scale = { kind: 'user', mmPerUnit: overrideMmPerUnit };
  } else if (derived === 'declared') {
    scale = { kind: 'declared', unit, mmPerUnit: sx };
  } else if (derived === 'assumed-px') {
    scale = { kind: 'assumed-px', mmPerUnit: sx };
  } else {
    scale = { kind: 'none' };
  }

  const extentX = viewBox ? viewBox.width : (width?.value ?? null);
  const extentY = viewBox ? viewBox.height : (height?.value ?? null);
  const known = scale.kind !== 'none';

  return {
    matrix,
    scale,
    drawingWidthMm: known && extentX !== null ? extentX * matrix.a : null,
    drawingHeightMm: known && extentY !== null ? extentY * matrix.d : null,
    warnings,
  };
}
