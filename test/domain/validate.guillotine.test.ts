import { describe, expect, it } from 'vitest';
import { clearance, type Rect, right } from '../../src/domain/geometry';
import { checkGuillotine } from '../../src/domain/validate';

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

const SHEET = rect(0, 0, 1000, 1000);

describe('checkGuillotine - trivially cuttable', () => {
  it('accepts an empty sheet', () => {
    expect(checkGuillotine(SHEET, [], 3)).toBe('valid');
  });

  it('accepts a single part anywhere on the sheet', () => {
    // The region boundary is itself a set of guillotine cuts, so one part
    // needs nothing further - wherever it sits.
    expect(checkGuillotine(SHEET, [rect(0, 0, 400, 400)], 3)).toBe('valid');
    expect(checkGuillotine(SHEET, [rect(250, 310, 400, 400)], 3)).toBe('valid');
  });
});

describe('checkGuillotine - kerf', () => {
  it('accepts two parts separated by exactly the kerf', () => {
    const parts = [rect(0, 0, 400, 1000), rect(403, 0, 400, 1000)];
    expect(checkGuillotine(SHEET, parts, 3)).toBe('valid');
  });

  it('rejects two parts closer together than the blade is wide', () => {
    // The cut that separates them has to come out of somewhere. A 2mm gap
    // cannot be produced by a 3mm blade: one of the parts loses a millimetre.
    const parts = [rect(0, 0, 400, 1000), rect(402, 0, 400, 1000)];
    expect(checkGuillotine(SHEET, parts, 3)).toBe('invalid');
  });

  it('accepts touching parts when the blade is ignored', () => {
    const parts = [rect(0, 0, 400, 1000), rect(400, 0, 400, 1000)];
    expect(checkGuillotine(SHEET, parts, 0)).toBe('valid');
  });

  it('charges no kerf at the region edge, where no cut happens', () => {
    // 400 + 3 + 597 fills the sheet exactly. There is one cut, between the two
    // parts, and it costs one kerf. The sheet's own edges cost nothing - the
    // material simply ends. A checker that charged kerf at the boundary would
    // reject this, and the tight-fit benchmark fixture would become unsolvable.
    const parts = [rect(0, 0, 400, 1000), rect(403, 0, 597, 1000)];
    expect(checkGuillotine(SHEET, parts, 3)).toBe('valid');
  });
});

describe('checkGuillotine - the pinwheel', () => {
  /**
   * Four parts rotated around a centre. Every pair clears every other pair, so
   * an overlap check waves it straight through, and there is no edge-to-edge
   * cut anywhere on the sheet: each of the four candidate lines runs through
   * one of the parts. This is the layout that separates a real guillotine
   * checker from a rectangle-overlap checker, and it is exactly the thing a
   * woodworker cannot cut on a table saw.
   */
  const pinwheelWithKerf: Rect[] = [
    rect(0, 0, 60, 40), // top-left, lying down
    rect(63, 0, 40, 60), // top-right, standing up
    rect(0, 43, 40, 60), // bottom-left, standing up
    rect(43, 63, 60, 40), // bottom-right, lying down
  ];
  const region = rect(0, 0, 106, 106);

  it('has no overlaps and honours the kerf, so nothing else would catch it', () => {
    for (let i = 0; i < pinwheelWithKerf.length; i += 1) {
      for (let j = i + 1; j < pinwheelWithKerf.length; j += 1) {
        const a = pinwheelWithKerf[i];
        const b = pinwheelWithKerf[j];
        if (a === undefined || b === undefined) throw new Error('bad fixture');
        expect(clearance(a, b)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('rejects it', () => {
    expect(checkGuillotine(region, pinwheelWithKerf, 3)).toBe('invalid');
  });

  it('rejects it with no kerf too', () => {
    const touching = [
      rect(0, 0, 60, 40),
      rect(60, 0, 40, 60),
      rect(0, 40, 40, 60),
      rect(40, 60, 60, 40),
    ];
    expect(checkGuillotine(rect(0, 0, 100, 100), touching, 0)).toBe('invalid');
  });

  it('rejects it however the parts are ordered', () => {
    // Cut candidates are enumerated in part order, so a checker that stopped at
    // the first workable-looking cut could give a different answer per ordering.
    const rotations = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ];
    for (const order of rotations) {
      const permuted = order.map((i) => {
        const r = pinwheelWithKerf[i];
        if (r === undefined) throw new Error('bad fixture');
        return r;
      });
      expect(checkGuillotine(region, permuted, 3)).toBe('invalid');
    }
  });

  it('accepts the same four parts once one is moved to unblock a cut', () => {
    // The control for the test above: if the checker rejected everything with
    // four parts in it, the pinwheel result would prove nothing. Sliding the
    // bottom-right part flush left opens a full-width cut at y = 63.
    const unwound = [
      rect(0, 0, 60, 40),
      rect(63, 0, 40, 60),
      rect(0, 63, 40, 40),
      rect(43, 63, 60, 40),
    ];
    expect(checkGuillotine(region, unwound, 3)).toBe('valid');
  });
});

describe('checkGuillotine - cut search', () => {
  it('falls back to the other axis when no cut works on the first', () => {
    // A full-width band under two side-by-side parts. No vertical cut exists
    // at the top level - the band straddles every candidate - so the checker
    // has to try horizontal cuts before concluding anything.
    const parts = [
      rect(0, 0, 500, 500),
      rect(503, 0, 400, 500),
      rect(0, 503, 900, 400), // spans both columns
    ];
    expect(checkGuillotine(SHEET, parts, 3)).toBe('valid');
  });

  it('alternates axes as it descends', () => {
    const parts = [
      rect(0, 0, 400, 1000), // full-height left column
      rect(403, 0, 400, 500), // right column, upper
      rect(403, 503, 200, 300), // right column, lower left
      rect(606, 503, 190, 300), // right column, lower right
    ];
    expect(checkGuillotine(SHEET, parts, 3)).toBe('valid');
  });

  it('rejects a staircase', () => {
    // Each part is offset from the last, so no line crosses the region without
    // running through something. Packs tightly, cannot be cut.
    const parts = [
      rect(0, 0, 600, 300),
      rect(603, 0, 300, 600),
      rect(0, 303, 300, 600),
      rect(303, 603, 600, 300),
      rect(303, 303, 297, 297),
    ];
    expect(checkGuillotine(rect(0, 0, 903, 903), parts, 3)).toBe('invalid');
  });
});

// --- Constructive cross-check --------------------------------------------

/**
 * Deterministic PRNG, local to this file.
 *
 * `solver/rng.ts` lands in a later PR and the repo bans `Math.random()`
 * outright, which is the right call: a test that shuffles differently on every
 * run reports a different bug every time it fails.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const MIN_PART = 40;

/**
 * Build a layout by actually performing guillotine cuts, so the answer is
 * known by construction rather than by inspection.
 *
 * This is the check that matters most in the other direction: a checker that
 * rejects valid layouts is just as useless as one that accepts invalid ones,
 * and off-by-one kerf handling in the split arithmetic shows up here
 * immediately as a false rejection.
 */
function cutUp(region: Rect, kerf: number, depth: number, rand: () => number): Rect[] {
  const canSplitX = region.width >= 2 * MIN_PART + kerf;
  const canSplitY = region.height >= 2 * MIN_PART + kerf;
  if (depth <= 0 || (!canSplitX && !canSplitY)) return [region];

  const splitX = canSplitX && (!canSplitY || rand() < 0.5);
  if (splitX) {
    const span = region.width - kerf - 2 * MIN_PART;
    const at = region.x + MIN_PART + Math.floor(rand() * (span + 1));
    return [
      ...cutUp({ ...region, width: at - region.x }, kerf, depth - 1, rand),
      ...cutUp(
        { ...region, x: at + kerf, width: right(region) - at - kerf },
        kerf,
        depth - 1,
        rand,
      ),
    ];
  }

  const span = region.height - kerf - 2 * MIN_PART;
  const at = region.y + MIN_PART + Math.floor(rand() * (span + 1));
  return [
    ...cutUp({ ...region, height: at - region.y }, kerf, depth - 1, rand),
    ...cutUp(
      { ...region, y: at + kerf, height: region.y + region.height - at - kerf },
      kerf,
      depth - 1,
      rand,
    ),
  ];
}

describe('checkGuillotine - layouts that are cuttable by construction', () => {
  for (const kerf of [0, 3, 3.175]) {
    it(`accepts every generated layout with a kerf of ${kerf}mm`, () => {
      const rand = lcg(20250803 + Math.round(kerf * 1000));

      for (let trial = 0; trial < 40; trial += 1) {
        const offcuts = cutUp(SHEET, kerf, 4, rand);
        // Shrink each part off its slot, so parts do not always sit flush
        // against the cut that freed them. Shrinking only widens gaps, so the
        // layout stays cuttable.
        const parts = offcuts.map((slot) => ({
          x: slot.x,
          y: slot.y,
          width: slot.width - Math.floor(rand() * 20),
          height: slot.height - Math.floor(rand() * 20),
        }));

        expect(parts.length).toBeGreaterThan(1);
        for (let i = 0; i < parts.length; i += 1) {
          for (let j = i + 1; j < parts.length; j += 1) {
            const a = parts[i];
            const b = parts[j];
            if (a === undefined || b === undefined) throw new Error('bad generator');
            // The generator must produce kerf-legal layouts, or the guillotine
            // result below would be testing the wrong thing.
            expect(clearance(a, b)).toBeGreaterThanOrEqual(kerf - 1e-9);
          }
        }

        expect(checkGuillotine(SHEET, parts, kerf)).toBe('valid');
      }
    });
  }
});

// --- The step cap ---------------------------------------------------------

describe('checkGuillotine - step cap', () => {
  const cuttable = [rect(0, 0, 400, 400), rect(403, 0, 400, 400), rect(0, 403, 400, 400)];

  it('proves the layout when given its normal budget', () => {
    expect(checkGuillotine(SHEET, cuttable, 3)).toBe('valid');
  });

  it('reports unverified rather than valid when the budget runs out', () => {
    // The single worst thing this checker could do is quietly downgrade "I gave
    // up" to "looks fine", because every other test in the project trusts it.
    expect(checkGuillotine(SHEET, cuttable, 3, 0)).toBe('unverified');
    expect(checkGuillotine(SHEET, cuttable, 3, 1)).toBe('unverified');
  });

  it('reports unverified rather than invalid when the budget runs out', () => {
    const pinwheel = [
      rect(0, 0, 60, 40),
      rect(63, 0, 40, 60),
      rect(0, 43, 40, 60),
      rect(43, 63, 60, 40),
    ];
    expect(checkGuillotine(rect(0, 0, 106, 106), pinwheel, 3, 0)).toBe('unverified');
  });

  it('still answers a deeply nested layout within the default budget', () => {
    // Memoisation on the region is what keeps the search from exploding here.
    const rand = lcg(7);
    const parts = cutUp(SHEET, 3, 7, rand);
    expect(parts.length).toBeGreaterThan(20);
    expect(checkGuillotine(SHEET, parts, 3)).toBe('valid');
  });
});
