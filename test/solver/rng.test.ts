import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/solver/rng';

/**
 * The golden vectors below are the whole point of this file.
 *
 * A saved project has to lay out identically when it is reopened, so the
 * generator's output stream is part of the product's contract, not an
 * implementation detail. Freezing the first few draws means any change to the
 * algorithm shows up as a diff in a review rather than as quietly different
 * layouts for every user who saved one.
 */
const GOLDEN: Record<number, number[]> = {
  0: [
    0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
    0.46732782293111086, 0.5450490827206522, 0.6152513844426721, 0.6489853798411787,
  ],
  1: [
    0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741,
    0.9683778982143849, 0.281103502959013, 0.6128388606011868, 0.7207431411370635,
  ],
  42: [
    0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
    0.17481389874592423, 0.5265925421845168, 0.2732279943302274, 0.6247446539346129,
  ],
};

function draw(seed: number, count: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.next());
}

describe('createRng', () => {
  it('produces its frozen output stream', () => {
    for (const [seed, expected] of Object.entries(GOLDEN)) {
      expect(draw(Number(seed), expected.length)).toEqual(expected);
    }
  });

  it('gives the same sequence twice for the same seed', () => {
    expect(draw(12345, 200)).toEqual(draw(12345, 200));
  });

  it('gives different sequences for different seeds', () => {
    expect(draw(1, 8)).not.toEqual(draw(2, 8));
  });

  it('accepts zero and negative seeds without degenerating', () => {
    // Some PRNGs stall on a zero seed. mulberry32 offsets before mixing, so it
    // does not - worth pinning, because 0 is the seed a user is most likely to
    // end up with by accident.
    for (const seed of [0, -1, -2147483648]) {
      const values = draw(seed, 16);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('rejects a seed that is not a finite number', () => {
    expect(() => createRng(Number.NaN)).toThrow();
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('stays inside [0, 1)', () => {
    for (const value of draw(99, 5000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    // Not a statistical test, just a canary for a generator that has collapsed
    // into one corner of the range.
    const buckets = new Array<number>(10).fill(0);
    const rng = createRng(2024);
    for (let i = 0; i < 100_000; i += 1) {
      const bucket = Math.floor(rng.next() * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9000);
      expect(count).toBeLessThan(11000);
    }
  });
});

describe('int', () => {
  it('produces the frozen sequence for a given seed and bound', () => {
    const rng = createRng(3);
    expect(Array.from({ length: 12 }, () => rng.int(6))).toEqual([
      4, 0, 2, 0, 4, 2, 2, 0, 1, 3, 1, 0,
    ]);
  });

  it('stays in [0, bound)', () => {
    const rng = createRng(5);
    for (const bound of [1, 2, 7, 100]) {
      for (let i = 0; i < 1000; i += 1) {
        const value = rng.int(bound);
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(bound);
      }
    }
  });

  it('reaches both ends of its range', () => {
    const rng = createRng(11);
    const seen = new Set(Array.from({ length: 500 }, () => rng.int(4)));
    expect(seen).toEqual(new Set([0, 1, 2, 3]));
  });

  it('rejects a bound that is not a positive integer', () => {
    // A caller bug, so it throws rather than returning a typed issue.
    const rng = createRng(1);
    for (const bound of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rng.int(bound)).toThrow();
    }
  });
});

describe('shuffle', () => {
  it('produces the frozen permutation for a given seed', () => {
    expect(createRng(7).shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      6, 5, 8, 1, 2, 3, 4, 7, 9, 0,
    ]);
  });

  it('does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const snapshot = [...input];
    createRng(1).shuffle(input);
    expect(input).toEqual(snapshot);
  });

  it('returns a permutation of its input', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const rng = createRng(31);
    for (let i = 0; i < 100; i += 1) {
      const out = rng.shuffle(input);
      expect(out.length).toBe(input.length);
      expect([...out].sort()).toEqual([...input].sort());
    }
  });

  it('handles empty and single-element arrays', () => {
    const rng = createRng(1);
    expect(rng.shuffle([])).toEqual([]);
    expect(rng.shuffle(['only'])).toEqual(['only']);
  });

  it('shuffles an array whose elements may be undefined', () => {
    // The Fisher-Yates swap reads slots that `noUncheckedIndexedAccess` types as
    // possibly undefined. Narrowing those away with a guard would silently skip
    // swaps here and change the permutation.
    const input = [1, undefined, 2, undefined, 3];
    const out = createRng(4).shuffle(input);
    expect(out.length).toBe(input.length);
    expect(out.filter((x) => x === undefined).length).toBe(2);
    expect(out.filter((x) => x !== undefined).sort()).toEqual([1, 2, 3]);
  });

  it('reaches every permutation of a small array', () => {
    const rng = createRng(2);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(rng.shuffle([1, 2, 3]).join(''));
    }
    expect(seen.size).toBe(6);
  });
});
