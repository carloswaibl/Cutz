import { describe, expect, it } from 'vitest';
import {
  formatLength,
  inchToMm,
  type LengthParseErrorKind,
  MM_PER_INCH,
  mmToInch,
  parseLength,
  type Unit,
} from '../../src/domain/units';

/** Parse and assert success, returning the millimetre value. */
function mm(input: string, unit: Unit = 'in'): number {
  const parsed = parseLength(input, unit);
  if (!parsed.ok) {
    throw new Error(
      `expected "${input}" to parse, got ${parsed.error.kind}: ${parsed.error.message}`,
    );
  }
  return parsed.mm;
}

/** Parse and assert failure, returning the error kind. */
function errorKind(input: string, unit: Unit = 'in'): LengthParseErrorKind {
  const parsed = parseLength(input, unit);
  if (parsed.ok) throw new Error(`expected "${input}" to fail, got ${parsed.mm}mm`);
  return parsed.error.kind;
}

describe('conversion', () => {
  it('round-trips', () => {
    expect(inchToMm(1)).toBe(MM_PER_INCH);
    expect(mmToInch(MM_PER_INCH)).toBe(1);
    expect(mmToInch(inchToMm(23.25))).toBeCloseTo(23.25, 10);
  });

  it('uses the exact international inch', () => {
    expect(MM_PER_INCH).toBe(25.4);
    // A 4'x8' sheet.
    expect(inchToMm(48)).toBeCloseTo(1219.2);
    expect(inchToMm(96)).toBeCloseTo(2438.4);
  });
});

describe('parseLength - decimals', () => {
  it('parses a plain decimal in the default unit', () => {
    expect(mm('600', 'mm')).toBeCloseTo(600);
    expect(mm('23.25', 'in')).toBeCloseTo(590.55);
  });

  it('accepts a leading decimal point', () => {
    expect(mm('.5', 'in')).toBeCloseTo(12.7);
  });

  it('accepts a trailing decimal point', () => {
    expect(mm('23.', 'in')).toBeCloseTo(584.2);
  });

  it('accepts zero, because a kerf of zero is meaningful', () => {
    expect(mm('0', 'mm')).toBe(0);
    expect(mm('0', 'in')).toBe(0);
  });
});

describe('parseLength - fractional inches', () => {
  it.each([
    ['23-1/4', 590.55],
    ['23 1/4', 590.55],
    ['23.25', 590.55],
    ['1/2', 12.7],
    ['3/4', 19.05],
    ['1/8', 3.175],
    ['0-1/2', 12.7],
    ['96-15/16', 2462.2125],
  ])('parses %s as %fmm', (input, expected) => {
    expect(mm(input, 'in')).toBeCloseTo(expected, 6);
  });

  it('reads all three spellings of the same dimension identically', () => {
    expect(mm('23-1/4')).toBeCloseTo(mm('23 1/4'), 9);
    expect(mm('23 1/4')).toBeCloseTo(mm('23.25'), 9);
  });

  it('tolerates whitespace around the fraction slash', () => {
    expect(mm('23 - 1 / 4')).toBeCloseTo(590.55, 6);
  });
});

describe('parseLength - unit suffixes', () => {
  it('lets an explicit suffix override the default unit', () => {
    expect(mm('600mm', 'in')).toBeCloseTo(600);
    expect(mm('23"', 'mm')).toBeCloseTo(584.2);
  });

  it.each([
    ['600mm', 600],
    ['600 mm', 600],
    ['60cm', 600],
    ['23in', 584.2],
    ['23 inch', 584.2],
    ['23 inches', 584.2],
    ['23"', 584.2],
    ['4ft', 1219.2],
    ["4'", 1219.2],
    ['4 feet', 1219.2],
    ['4 foot', 1219.2],
    ["4-1/2'", 1371.6],
  ])('parses %s as %fmm', (input, expected) => {
    expect(mm(input, 'mm')).toBeCloseTo(expected, 6);
  });

  it('is case insensitive', () => {
    expect(mm('600MM', 'in')).toBeCloseTo(600);
    expect(mm('23IN', 'mm')).toBeCloseTo(584.2);
  });
});

describe('parseLength - messy real-world input', () => {
  it('trims surrounding whitespace', () => {
    expect(mm('   23-1/4   ')).toBeCloseTo(590.55, 6);
  });

  it('accepts smart quotes and primes from copy-paste', () => {
    expect(mm('23”', 'mm')).toBeCloseTo(584.2);
    expect(mm('23″', 'mm')).toBeCloseTo(584.2);
    expect(mm('4’', 'mm')).toBeCloseTo(1219.2);
    expect(mm('4′', 'mm')).toBeCloseTo(1219.2);
  });

  it('accepts an en dash where a hyphen was meant', () => {
    expect(mm('23–1/4')).toBeCloseTo(590.55, 6);
  });

  it('accepts typographic fraction glyphs', () => {
    expect(mm('23½')).toBeCloseTo(596.9, 6);
    expect(mm('23¼')).toBeCloseTo(590.55, 6);
    expect(mm('23¾"', 'mm')).toBeCloseTo(603.25, 6);
    expect(mm('⅛')).toBeCloseTo(3.175, 6);
  });

  it('accepts a fraction slash', () => {
    expect(mm('1⁄2')).toBeCloseTo(12.7, 6);
  });
});

describe('parseLength - failures', () => {
  it('rejects empty input', () => {
    expect(errorKind('')).toBe('empty');
    expect(errorKind('   ')).toBe('empty');
  });

  it('rejects text', () => {
    expect(errorKind('abc')).toBe('unparseable');
    expect(errorKind('wide')).toBe('unparseable');
  });

  it('rejects negative measurements', () => {
    expect(errorKind('-5')).toBe('negative');
    expect(errorKind('-23-1/4')).toBe('negative');
    expect(errorKind('−5')).toBe('negative');
  });

  it('rejects a fraction over zero rather than returning Infinity', () => {
    expect(errorKind('1/0')).toBe('zero-denominator');
    expect(errorKind('23-1/0')).toBe('zero-denominator');
  });

  it('rejects combined feet-and-inches instead of silently reading the feet', () => {
    // The dangerous failure: parsing 4' 6" as 4 feet would be off by half a
    // foot and look entirely plausible in the layout.
    expect(errorKind('4\' 6"')).toBe('mixed-units');
    expect(errorKind('4 ft 6 in')).toBe('mixed-units');
  });

  it('rejects trailing text after a unit', () => {
    expect(errorKind('23 in extra')).toBe('unparseable');
    expect(errorKind('12mm x 4')).toBe('unparseable');
  });

  it('rejects a bare unit', () => {
    expect(errorKind('mm')).toBe('unparseable');
    expect(errorKind('"')).toBe('unparseable');
  });

  it('rejects a value that overflows to Infinity', () => {
    expect(errorKind('9'.repeat(400))).toBe('unparseable');
  });

  it('names the offending input in every message', () => {
    for (const input of ['abc', '-5', '1/0', '4\' 6"', '23 in extra']) {
      const parsed = parseLength(input, 'in');
      if (parsed.ok) throw new Error(`expected "${input}" to fail`);
      expect(parsed.error.message).toContain(input.trim());
      expect(parsed.error.input).toBe(input);
    }
  });
});

describe('formatLength - imperial', () => {
  it('formats an exact sixteenth without an approximation marker', () => {
    expect(formatLength(590.55, { unit: 'in' })).toBe('23-1/4"');
    expect(formatLength(12.7, { unit: 'in' })).toBe('1/2"');
    expect(formatLength(609.6, { unit: 'in' })).toBe('24"');
    expect(formatLength(0, { unit: 'in' })).toBe('0"');
  });

  it('reduces the fraction to lowest terms', () => {
    // 23-4/16 is the naive output and reads as a mistake to a woodworker.
    expect(formatLength(590.55, { unit: 'in' })).toBe('23-1/4"');
    expect(formatLength(inchToMm(23.5), { unit: 'in' })).toBe('23-1/2"');
    expect(formatLength(inchToMm(23.125), { unit: 'in' })).toBe('23-1/8"');
    expect(formatLength(inchToMm(0.75), { unit: 'in' })).toBe('3/4"');
  });

  it('marks a value that does not land on the grid', () => {
    // 600mm is not a round imperial number and never will be.
    expect(formatLength(600, { unit: 'in' })).toBe('~23-5/8"');
  });

  it('honours a finer denominator', () => {
    expect(formatLength(inchToMm(23 + 1 / 32), { unit: 'in', denominator: 32 })).toBe('23-1/32"');
    // At tape-measure resolution 1/32 is an exact tie; it breaks upward.
    expect(formatLength(inchToMm(23 + 1 / 32), { unit: 'in', denominator: 16 })).toBe('~23-1/16"');
  });

  it('rounds a half-tick away from zero rather than losing it to float storage', () => {
    // 23-3/32" is 590.5506...mm, above the 1/16 tie; 23-1/32" is below it.
    expect(formatLength(inchToMm(23 + 3 / 32), { unit: 'in', denominator: 16 })).toBe('~23-1/8"');
  });

  it('can omit the unit symbol, for input fields', () => {
    expect(formatLength(590.55, { unit: 'in', withUnit: false })).toBe('23-1/4');
  });

  it('can suppress the approximation marker', () => {
    expect(formatLength(600, { unit: 'in', markApproximate: false })).toBe('23-5/8"');
  });

  it('formats negatives without losing the sign', () => {
    expect(formatLength(-590.55, { unit: 'in' })).toBe('-23-1/4"');
  });
});

describe('formatLength - metric', () => {
  it('drops meaningless trailing zeros', () => {
    expect(formatLength(600, { unit: 'mm' })).toBe('600 mm');
    expect(formatLength(2440.5, { unit: 'mm' })).toBe('2440.5 mm');
  });

  it('honours a decimal-place count', () => {
    expect(formatLength(2440, { unit: 'mm', decimals: 0 })).toBe('2440 mm');
    expect(formatLength(590.55, { unit: 'mm', decimals: 2 })).toBe('590.55 mm');
  });

  it('marks a value lost to rounding', () => {
    expect(formatLength(100.06, { unit: 'mm', decimals: 1 })).toBe('~100.1 mm');
    expect(formatLength(590.55, { unit: 'mm', decimals: 1 })).toBe('~590.6 mm');
  });

  it('can omit the unit symbol', () => {
    expect(formatLength(600, { unit: 'mm', withUnit: false })).toBe('600');
  });
});

describe('parse/format round-trip', () => {
  it.each(['23-1/4', '1/2', '96', '11-7/8', '3/16'])(
    'survives a round-trip through millimetres for %s',
    (input) => {
      const asMm = mm(input, 'in');
      expect(formatLength(asMm, { unit: 'in', withUnit: false })).toBe(input);
    },
  );

  it('re-parses its own metric output', () => {
    const original = 1220;
    const rendered = formatLength(original, { unit: 'mm' });
    expect(mm(rendered, 'mm')).toBeCloseTo(original, 6);
  });
});
