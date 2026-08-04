import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../src/domain/geometry';
import type { Part, RotationPolicy } from '../../../src/domain/types';
import {
  bestFit,
  chooseSplitAxis,
  type FitHeuristic,
  type Footprint,
  FreeRectList,
  fitScore,
  orderParts,
  orientations,
  type SplitRule,
  split,
} from '../../../src/solver/guillotine/freeRects';

function part(
  width: number,
  height: number,
  rotationPolicy: RotationPolicy = 'free90',
  id = 'p',
): Part {
  return { id, label: id, width, height, qty: 1, materialId: 'ply18', rotationPolicy };
}

function fp(width: number, height: number, rotated = false): Footprint {
  return { width, height, rotated };
}

describe('orientations', () => {
  it('offers both ways round for a free90 part', () => {
    expect(orientations(part(600, 300))).toEqual([
      { width: 600, height: 300, rotated: false },
      { width: 300, height: 600, rotated: true },
    ]);
  });

  it('offers only the upright orientation for a grain-locked part', () => {
    // Grain lock is a hard constraint: turning the part puts the visible wood
    // fibre across the piece. The packer is never even shown the option.
    expect(orientations(part(600, 300, 'locked'))).toEqual([
      { width: 600, height: 300, rotated: false },
    ]);
  });

  it('offers a square part once, since both orientations are the same footprint', () => {
    expect(orientations(part(600, 600))).toEqual([{ width: 600, height: 600, rotated: false }]);
  });

  it('treats a part square within EPSILON as square', () => {
    expect(orientations(part(600, 600 + 1e-9))).toHaveLength(1);
  });
});

describe('fitScore', () => {
  const rect: Rect = { x: 0, y: 0, width: 1000, height: 500 };

  it('best-area scores the leftover area', () => {
    expect(fitScore(fp(600, 300), rect, 'best-area')).toBe(1000 * 500 - 600 * 300);
  });

  it('best-short-side scores the smaller leftover dimension', () => {
    expect(fitScore(fp(600, 300), rect, 'best-short-side')).toBe(200);
  });

  it('best-long-side scores the larger leftover dimension', () => {
    expect(fitScore(fp(600, 300), rect, 'best-long-side')).toBe(400);
  });

  it('best-area cannot tell the two orientations of a part apart', () => {
    // Not a defect to fix here, but worth pinning: the leftover *area* is the
    // same whichever way round the part goes, so under best-area a rotation is
    // only ever chosen when the upright orientation does not fit at all.
    const square: Rect = { x: 0, y: 0, width: 1000, height: 1000 };
    expect(fitScore(fp(600, 300), square, 'best-area')).toBe(
      fitScore(fp(300, 600, true), square, 'best-area'),
    );
  });
});

describe('chooseSplitAxis', () => {
  const rect: Rect = { x: 0, y: 0, width: 1000, height: 500 };
  // Placing 600x300 leaves 400 across and 200 down.
  const footprint = fp(600, 300);

  const cases: [SplitRule, string][] = [
    ['shorter-leftover', 'vertical'],
    ['longer-leftover', 'horizontal'],
    ['shorter-axis', 'vertical'],
    ['longer-axis', 'horizontal'],
  ];

  for (const [rule, expected] of cases) {
    it(`${rule} cuts ${expected}`, () => {
      expect(chooseSplitAxis(footprint, rect, rule)).toBe(expected);
    });
  }
});

describe('split', () => {
  const rect: Rect = { x: 10, y: 20, width: 1000, height: 500 };

  it('horizontal gives the bottom child the parent full width', () => {
    expect(split(rect, fp(600, 300), 3, 'horizontal')).toEqual([
      { x: 613, y: 20, width: 397, height: 300 },
      { x: 10, y: 323, width: 1000, height: 197 },
    ]);
  });

  it('vertical gives the right child the parent full height', () => {
    expect(split(rect, fp(600, 300), 3, 'vertical')).toEqual([
      { x: 613, y: 20, width: 397, height: 500 },
      { x: 10, y: 323, width: 600, height: 197 },
    ]);
  });

  it('charges no kerf where the part is flush with the parent edge', () => {
    // The single most important case in this file. A part filling the parent's
    // full width produces no right child, because there is nothing on the far
    // side to cut away - so no cut happens and no kerf is consumed. Charging it
    // anyway loses a blade's width of capacity per sheet edge, which is exactly
    // enough to make a part that should fit not fit.
    const children = split({ x: 0, y: 0, width: 600, height: 500 }, fp(600, 200), 3, 'horizontal');
    expect(children).toEqual([{ x: 0, y: 203, width: 600, height: 297 }]);
  });

  it('produces no children at all when the part fills the parent exactly', () => {
    expect(split({ x: 0, y: 0, width: 600, height: 500 }, fp(600, 500), 3, 'horizontal')).toEqual(
      [],
    );
  });

  it('does not create a child that the kerf itself consumed', () => {
    // 600 of part + 3 of kerf leaves 1mm, which is not a child. Making one
    // would put a rectangle on the sheet where the blade actually went.
    const children = split({ x: 0, y: 0, width: 604, height: 500 }, fp(600, 500), 3, 'vertical');
    expect(children).toEqual([{ x: 603, y: 0, width: 1, height: 500 }]);
  });

  it('with zero kerf the children meet the part exactly', () => {
    expect(split({ x: 0, y: 0, width: 1000, height: 500 }, fp(600, 300), 0, 'horizontal')).toEqual([
      { x: 600, y: 0, width: 400, height: 300 },
      { x: 0, y: 300, width: 1000, height: 200 },
    ]);
  });
});

describe('FreeRectList', () => {
  it('replaces the placed rectangle with its children, in its own slot', () => {
    const list = new FreeRectList({ x: 0, y: 0, width: 1000, height: 1000 });
    list.place(0, fp(400, 400), 3, 'longer-leftover');
    // Order is a pure function of the placement sequence, which is what makes
    // the tie-break on rectangle index deterministic.
    expect(list.list()).toEqual([
      { x: 403, y: 0, width: 597, height: 400 },
      { x: 0, y: 403, width: 1000, height: 597 },
    ]);
  });

  it('throws when asked to place into a rectangle that is not there', () => {
    const list = new FreeRectList({ x: 0, y: 0, width: 100, height: 100 });
    expect(() => list.place(5, fp(10, 10), 0, 'longer-leftover')).toThrow(/does not exist/);
  });

  it('prunes rectangles too small for any remaining part, in either axis', () => {
    const list = new FreeRectList({ x: 0, y: 0, width: 1000, height: 1000 });
    list.place(0, fp(990, 400), 3, 'longer-leftover');
    expect(list.list()).toHaveLength(2);
    list.prune(100, 100);
    // The 7mm-wide right child cannot hold anything; the bottom child can.
    expect(list.list()).toEqual([{ x: 0, y: 403, width: 990, height: 597 }]);
  });

  it('keeps a rectangle that matches the bound exactly', () => {
    const list = new FreeRectList({ x: 0, y: 0, width: 100, height: 100 });
    list.prune(100, 100);
    expect(list.list()).toHaveLength(1);
  });
});

describe('bestFit', () => {
  it('returns null when the part fits nowhere', () => {
    expect(bestFit(part(900, 900), [{ x: 0, y: 0, width: 500, height: 500 }], 'best-area')).toBe(
      null,
    );
  });

  it('never rotates a grain-locked part, even when only rotation would fit', () => {
    const rects: Rect[] = [{ x: 0, y: 0, width: 400, height: 700 }];
    expect(bestFit(part(600, 300, 'locked'), rects, 'best-area')).toBe(null);
    expect(bestFit(part(600, 300, 'free90'), rects, 'best-area')?.footprint).toEqual({
      width: 300,
      height: 600,
      rotated: true,
    });
  });

  it('picks the smallest-area rectangle that fits under best-area', () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 1000, height: 1000 },
      { x: 0, y: 0, width: 610, height: 610 },
      { x: 0, y: 0, width: 300, height: 300 },
    ];
    expect(bestFit(part(600, 600), rects, 'best-area')?.rectIndex).toBe(1);
  });

  it('breaks a tie on the lower rectangle index', () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 700, height: 700 },
      { x: 50, y: 50, width: 700, height: 700 },
    ];
    for (const heuristic of ['best-area', 'best-short-side', 'best-long-side'] as FitHeuristic[]) {
      expect(bestFit(part(600, 600), rects, heuristic)?.rectIndex).toBe(0);
    }
  });

  it('breaks an orientation tie towards not rotating', () => {
    // A meaningless rotation would still be a visible difference in the saved
    // project and in the printed diagram.
    const rects: Rect[] = [{ x: 0, y: 0, width: 1000, height: 1000 }];
    expect(bestFit(part(600, 300), rects, 'best-area')?.footprint.rotated).toBe(false);
  });

  it('rotates when the heuristic can see that it fits better', () => {
    // best-short-side can distinguish orientations where best-area cannot.
    const rects: Rect[] = [{ x: 0, y: 0, width: 320, height: 1000 }];
    expect(bestFit(part(600, 300), rects, 'best-short-side')?.footprint).toEqual({
      width: 300,
      height: 600,
      rotated: true,
    });
  });
});

describe('orderParts', () => {
  const instances = [
    { part: part(100, 100, 'free90', 'small') },
    { part: part(900, 50, 'free90', 'long') },
    { part: part(400, 400, 'free90', 'big') },
  ];

  it('sorts by area descending', () => {
    // 160,000 then 45,000 then 10,000 - `long` is a thin part with a big span,
    // which is exactly where the three orderings disagree.
    expect(orderParts(instances, 'area-desc').map((i) => i.part.id)).toEqual([
      'big',
      'long',
      'small',
    ]);
  });

  it('sorts by longest side descending', () => {
    expect(orderParts(instances, 'longest-side-desc').map((i) => i.part.id)).toEqual([
      'long',
      'big',
      'small',
    ]);
  });

  it('sorts by perimeter descending', () => {
    expect(orderParts(instances, 'perimeter-desc').map((i) => i.part.id)).toEqual([
      'long',
      'big',
      'small',
    ]);
  });

  it('leaves declaration order alone', () => {
    expect(orderParts(instances, 'declaration').map((i) => i.part.id)).toEqual([
      'small',
      'long',
      'big',
    ]);
  });

  it('is stable, so equal keys keep declaration order', () => {
    const tied = [
      { part: part(100, 100, 'free90', 'first') },
      { part: part(100, 100, 'free90', 'second') },
      { part: part(50, 200, 'free90', 'third') },
    ];
    expect(orderParts(tied, 'area-desc').map((i) => i.part.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('does not mutate its input', () => {
    const before = instances.map((i) => i.part.id);
    orderParts(instances, 'area-desc');
    expect(instances.map((i) => i.part.id)).toEqual(before);
  });
});
