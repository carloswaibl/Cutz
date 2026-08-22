/**
 * Unit conversion and fractional-inch parsing/formatting.
 *
 * The canonical internal unit is millimetres. This module is the *only* place
 * that knows any other unit exists - it sits at the UI boundary, converts, and
 * hands millimetres to the domain. Nothing here returns a value carrying a unit
 * tag, and nothing in the domain model stores a display string.
 *
 * Pure and headless: no DOM, no locale APIs, no `Intl`. The US hobbyist market
 * is imperial and writes dimensions as `23-1/4`, so fractional input is a real
 * requirement rather than a nicety.
 */

import { approxEq } from './geometry';

/** Units the UI can display in. Parsing accepts more suffixes than this. */
export type Unit = 'mm' | 'in';

/**
 * Metric is millimetres only, deliberately. Sheet goods, cabinet plans and saw
 * scales are all specified in mm, so a centimetre setting buys nothing and puts
 * a third case in every formatter, table and exporter that fans out from here.
 * `parseLength` still accepts a `cm` suffix on input, so a user who thinks in
 * centimetres can type `60cm` and get 600mm whatever this is set to.
 */
export type DisplayUnit = 'imperial-fraction' | 'imperial-decimal' | 'metric-mm';

export const MM_PER_INCH = 25.4;

export function mmToInch(mm: number): number {
  return mm / MM_PER_INCH;
}

export function inchToMm(inch: number): number {
  return inch * MM_PER_INCH;
}

// --- Parsing -------------------------------------------------------------

export type LengthParseErrorKind =
  | 'empty'
  | 'unparseable'
  | 'negative'
  | 'zero-denominator'
  | 'mixed-units';

export interface LengthParseError {
  kind: LengthParseErrorKind;
  /** Exactly what the caller passed in, unnormalised, for echoing back. */
  input: string;
  /**
   * User-facing. A user must always learn *which* part of what they typed was
   * not understood - never a bare "invalid input".
   */
  message: string;
}

export type ParsedLength = { ok: true; mm: number } | { ok: false; error: LengthParseError };

/**
 * Suffixes accepted on input, mapped to their millimetre scale.
 *
 * Feet are here because sheet goods are sold as 4'x8' and a user entering stock
 * will reach for that notation before they reach for 1220x2440.
 */
const SUFFIX_SCALE = new Map<string, number>([
  ['mm', 1],
  ['cm', 10],
  ['in', MM_PER_INCH],
  ['inch', MM_PER_INCH],
  ['inches', MM_PER_INCH],
  ['"', MM_PER_INCH],
  ['ft', MM_PER_INCH * 12],
  ['foot', MM_PER_INCH * 12],
  ['feet', MM_PER_INCH * 12],
  ["'", MM_PER_INCH * 12],
]);

// Longest alternatives first so "inches" is one token rather than "in" + junk.
const UNIT_TOKEN_SOURCE = 'inches|inch|feet|foot|mm|cm|in|ft|"|\'';
const UNIT_TOKEN_GLOBAL = new RegExp(UNIT_TOKEN_SOURCE, 'g');
const UNIT_SUFFIX = new RegExp(`(${UNIT_TOKEN_SOURCE})$`);

const MIXED_NUMBER = /^(\d+)\s*[-\s]\s*(\d+)\s*\/\s*(\d+)$/;
const FRACTION = /^(\d+)\s*\/\s*(\d+)$/;
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Fold the ways a real user's input differs from the canonical spelling:
 * smart quotes and primes from copy-paste, en/em dashes from autocorrect,
 * typographic fraction glyphs from web pages, and the fraction slash.
 */
function normalize(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[‘’′]/g, "'")
      .replace(/[“”″]/g, '"')
      .replace(/⁄/g, '/')
      // U+2010..U+2015 are the hyphen/dash family, U+2212 is the minus sign.
      .replace(/[‐-―−]/g, '-')
      .replace(/¼/g, ' 1/4')
      .replace(/½/g, ' 1/2')
      .replace(/¾/g, ' 3/4')
      .replace(/⅛/g, ' 1/8')
      .replace(/⅜/g, ' 3/8')
      .replace(/⅝/g, ' 5/8')
      .replace(/⅞/g, ' 7/8')
      .trim()
  );
}

/**
 * Read a capture group that the pattern guarantees is present.
 *
 * `noUncheckedIndexedAccess` types every group as possibly-undefined. None of
 * the patterns here have optional groups, so this is an internal invariant, not
 * user-input handling - hence a throw rather than a typed error.
 */
function group(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`length pattern is missing capture group ${index}`);
  }
  return value;
}

type Magnitude =
  | { ok: true; value: number }
  | { ok: false; kind: 'unparseable' | 'zero-denominator' };

function parseMagnitude(body: string): Magnitude {
  const mixed = MIXED_NUMBER.exec(body);
  if (mixed) {
    const denominator = Number(group(mixed, 3));
    if (denominator === 0) return { ok: false, kind: 'zero-denominator' };
    return { ok: true, value: Number(group(mixed, 1)) + Number(group(mixed, 2)) / denominator };
  }

  const fraction = FRACTION.exec(body);
  if (fraction) {
    const denominator = Number(group(fraction, 2));
    if (denominator === 0) return { ok: false, kind: 'zero-denominator' };
    return { ok: true, value: Number(group(fraction, 1)) / denominator };
  }

  if (DECIMAL.test(body)) {
    const value = Number(body);
    // A few hundred digits overflows to Infinity, which would sail through as a
    // dimension and poison every area computation downstream.
    if (!Number.isFinite(value)) return { ok: false, kind: 'unparseable' };
    return { ok: true, value };
  }

  return { ok: false, kind: 'unparseable' };
}

function fail(kind: LengthParseErrorKind, input: string, message: string): ParsedLength {
  return { ok: false, error: { kind, input, message } };
}

/**
 * Parse a user-entered length into millimetres.
 *
 * `defaultUnit` applies only when the input carries no suffix of its own - an
 * explicit `600mm` is 600mm even when the UI is set to inches.
 *
 * Zero is accepted: a kerf of 0 is meaningful (a user who wants kerf ignored).
 * Rejecting values that must be positive is `validate.ts`'s job, per field.
 */
export function parseLength(input: string, defaultUnit: Unit): ParsedLength {
  const text = normalize(input);
  if (text === '') {
    return fail('empty', input, 'Enter a measurement.');
  }

  const tokens = text.match(UNIT_TOKEN_GLOBAL) ?? [];
  if (tokens.length > 1) {
    return fail(
      'mixed-units',
      input,
      `"${input.trim()}" combines two units. Enter a single value, such as 4-1/2' or 54".`,
    );
  }

  let scale = defaultUnit === 'mm' ? 1 : MM_PER_INCH;
  let body = text;
  const suffix = UNIT_SUFFIX.exec(text);
  if (suffix) {
    const symbol = group(suffix, 1);
    const known = SUFFIX_SCALE.get(symbol);
    if (known === undefined) {
      throw new Error(`unit suffix "${symbol}" matched but has no scale`);
    }
    scale = known;
    body = text.slice(0, text.length - symbol.length).trim();
  } else if (tokens.length === 1) {
    // A unit appears, but not at the end - "23 in extra", "12mm x 4".
    return fail('unparseable', input, `"${input.trim()}" has text after the unit.`);
  }

  let negative = false;
  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1).trim();
  }

  const magnitude = parseMagnitude(body);
  if (!magnitude.ok) {
    if (magnitude.kind === 'zero-denominator') {
      return fail('zero-denominator', input, `"${input.trim()}" has a fraction over zero.`);
    }
    return fail(
      'unparseable',
      input,
      `"${input.trim()}" is not a measurement. Try 600, 23-1/4, or 23.25.`,
    );
  }

  if (negative && magnitude.value !== 0) {
    return fail('negative', input, `"${input.trim()}" is negative. Measurements cannot be.`);
  }

  return { ok: true, mm: magnitude.value * scale };
}

// --- Formatting ----------------------------------------------------------

export interface FormatLengthOptions {
  unit: Unit;
  /**
   * Imperial only: round to the nearest 1/denominator. Defaults to 16, the
   * resolution of an ordinary tape measure.
   */
  denominator?: number;
  /** Metric only: maximum decimal places. Defaults to 1. */
  decimals?: number;
  /** Append the unit symbol. Defaults to true. */
  withUnit?: boolean;
  /**
   * Prefix `~` when rounding moved the value. Defaults to true, because a
   * woodworker cutting to a displayed number needs to know it is not the exact
   * one - 600mm is `~23-5/8"`, and the difference is a visible gap in a joint.
   */
  markApproximate?: boolean;
}

/** Below this the residual is float noise from conversion, not real rounding. */
const TICK_EPSILON = 1e-6;

function greatestCommonDivisor(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function trimTrailingZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/**
 * Round `value * factor` to an integer, half away from zero.
 *
 * A decimal literal like 590.55 - which is exactly what 23-1/4" converts to -
 * is stored as a double a hair *below* itself, so `(590.55).toFixed(1)` yields
 * "590.5" rather than "590.6". The one-ULP nudge lands values that sit on a
 * rounding boundary on the correct side of it, and is far too small to move a
 * value that is not already on one.
 */
function roundTicks(value: number, factor: number): number {
  return Math.round(value * factor * (1 + Number.EPSILON));
}

/** Render a millimetre value for display. Never feed the result back into the domain. */
export function formatLength(mm: number, options: FormatLengthOptions): string {
  const { unit, withUnit = true, markApproximate = true } = options;
  const sign = mm < 0 ? '-' : '';
  const magnitude = Math.abs(mm);

  if (unit === 'mm') {
    const decimals = options.decimals ?? 1;
    const factor = 10 ** decimals;
    const rounded = roundTicks(magnitude, factor) / factor;
    const text = trimTrailingZeros(rounded.toFixed(decimals));
    const approximate = markApproximate && !approxEq(rounded, magnitude) ? '~' : '';
    return `${approximate}${sign}${text}${withUnit ? ' mm' : ''}`;
  }

  const denominator = options.denominator ?? 16;
  const inches = magnitude / MM_PER_INCH;
  const ticks = roundTicks(inches, denominator);
  const approximate =
    markApproximate && Math.abs(inches * denominator - ticks) > TICK_EPSILON ? '~' : '';

  const whole = Math.floor(ticks / denominator);
  const remainder = ticks % denominator;

  let body: string;
  if (remainder === 0) {
    body = `${whole}`;
  } else {
    // Reduce so the display reads 23-1/4, never 23-4/16.
    const divisor = greatestCommonDivisor(remainder, denominator);
    const fraction = `${remainder / divisor}/${denominator / divisor}`;
    body = whole === 0 ? fraction : `${whole}-${fraction}`;
  }

  return `${approximate}${sign}${body}${withUnit ? '"' : ''}`;
}
