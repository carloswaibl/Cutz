import { describe, expect, it } from 'vitest';
import { polygonSeparation } from '../../../src/domain/polygon';
import type { Point } from '../../../src/domain/types';
import {
  cellSizeFor,
  dilate,
  dilationOffsets,
  getBit,
  popCount,
  rasterise,
} from '../../../src/solver/nest/raster';

function ring(points: readonly [number, number][]): Point[] {
  return points.map(([x, y]) => ({ x, y }));
}

const SQUARE = ring([
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
]);

describe('rasterise', () => {
  it('covers a square exactly, with no rounding either way', () => {
    const mask = rasterise(SQUARE, 10);
    expect({ cols: mask.cols, rows: mask.rows }).toEqual({ cols: 10, rows: 10 });
    expect(popCount(mask)).toBe(100);
  });

  it('rounds a part up to whole cells rather than clipping it', () => {
    // 105mm on a 10mm grid is eleven cells, not ten. Conservative rounding is
    // the property every later guarantee rests on: a shape must never extend
    // past the cells claimed for it, because the kerf argument assumes every
    // point of it lies inside some marked cell.
    const mask = rasterise(
      ring([
        [0, 0],
        [105, 0],
        [105, 105],
        [0, 105],
      ]),
      10,
    );
    expect({ cols: mask.cols, rows: mask.rows }).toEqual({ cols: 11, rows: 11 });
    expect(popCount(mask)).toBe(121);
  });

  it('covers every cell a diagonal edge passes through', () => {
    // A triangle's hypotenuse is the case point sampling gets wrong: it clips
    // corners of cells that no sample lands in. Every cell the line crosses has
    // to be marked, or two nested triangles would be allowed to overlap along
    // exactly the edge that makes them nest.
    const mask = rasterise(
      ring([
        [0, 0],
        [100, 0],
        [0, 100],
      ]),
      10,
    );
    // The anti-diagonal is on the boundary, so both it and everything above and
    // left of it is occupied: 10 + 9 + ... + 1 interior, plus the diagonal row.
    for (let i = 0; i < 10; i += 1) {
      expect(getBit(mask, 9 - i, i), `diagonal cell ${i}`).toBe(true);
    }
    // And the far corner, which is entirely outside the triangle, is not.
    expect(getBit(mask, 9, 9)).toBe(false);
  });

  it('marks a shape thinner than one cell rather than losing it', () => {
    // A 2mm sliver on a 10mm grid has no cell midpoint inside it at all, so the
    // scanline pass alone would return an empty mask - and an empty mask
    // collides with nothing and would be placed straight on top of a neighbour.
    const mask = rasterise(
      ring([
        [0, 0],
        [100, 0],
        [100, 2],
        [0, 2],
      ]),
      10,
    );
    expect(popCount(mask)).toBe(10);
  });

  it('anchors the mask at the ring’s own bounds, wherever the ring sits', () => {
    // This is what lets a mask at cell (c, r) be reported as a placement at
    // `usable + (c, r) * cell` with no correction, and it is what makes
    // `placementPolygon` agree with the packer about where a part is.
    const here = rasterise(SQUARE, 10);
    const there = rasterise(
      SQUARE.map((p) => ({ x: p.x + 613, y: p.y - 47 })),
      10,
    );
    expect([...there.bits]).toEqual([...here.bits]);
  });

  it('returns an empty mask for a degenerate ring rather than throwing', () => {
    expect(rasterise([{ x: 0, y: 0 }], 10).rows).toBe(0);
    expect(rasterise(SQUARE, 0).rows).toBe(0);
  });
});

describe('cellSizeFor', () => {
  it('divides the kerf exactly, which is where the engine’s quality comes from', () => {
    // `dilationOffsets` can only separate parts by whole cells, so the gap it
    // leaves is the kerf rounded up to a multiple of the cell. When the cell
    // divides the kerf there is no rounding at all - and on `bookshelf` that
    // single millimetre is the difference between four 300mm rows on a sheet
    // and three, which is a whole extra sheet.
    for (const kerf of [3, 3.175, 6, 1.5, 12]) {
      const cell = cellSizeFor(kerf);
      expect(Number.isInteger(+(kerf / cell).toFixed(9)), `kerf ${kerf} / cell ${cell}`).toBe(true);
    }
  });

  it('keeps the grid near the target rather than following the kerf anywhere', () => {
    expect(cellSizeFor(3)).toBe(3);
    expect(cellSizeFor(3.175)).toBe(3.175);
    expect(cellSizeFor(6)).toBe(3);
    expect(cellSizeFor(12)).toBe(3);
  });

  it('refuses to grid a whole sheet at laser resolution', () => {
    // A 0.2mm kerf would otherwise ask for twelve million cells to save a fifth
    // of a millimetre. Rounding the gap up instead is the safe direction.
    expect(cellSizeFor(0.2)).toBe(1);
    expect(cellSizeFor(0.2)).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the target for a kerf of zero or nonsense', () => {
    expect(cellSizeFor(0)).toBe(3);
    expect(cellSizeFor(Number.NaN)).toBe(3);
    expect(cellSizeFor(-5)).toBe(3);
  });
});

describe('dilationOffsets', () => {
  /**
   * The closest two points in cells `Δ` apart can possibly be.
   *
   * Cells touch, so neighbours may be zero apart - hence the `-1`. This is the
   * bound the whole kerf guarantee is derived from.
   */
  function closestApproach(di: number, dj: number, cell: number): number {
    const x = Math.max(0, Math.abs(di) - 1) * cell;
    const y = Math.max(0, Math.abs(dj) - 1) * cell;
    return Math.hypot(x, y);
  }

  it('contains every offset that could bring two parts closer than the kerf', () => {
    // The contract, stated directly: if an offset is *not* in the element then
    // two parts at that offset are provably at least a kerf apart, and if it
    // could be closer then it is in. Nothing else in the engine checks
    // clearance, so this is the guarantee in full.
    for (const [kerf, cell] of [
      [3, 3],
      [3, 1],
      [3.175, 3.175],
      [6, 3],
      [1, 1],
    ] as const) {
      const offsets = dilationOffsets(kerf, cell);
      const inside = new Set(offsets.map((o) => `${o.di},${o.dj}`));
      const reach = Math.ceil(kerf / cell) + 3;
      for (let dj = -reach; dj <= reach; dj += 1) {
        for (let di = -reach; di <= reach; di += 1) {
          const gap = closestApproach(di, dj, cell);
          const held = inside.has(`${di},${dj}`);
          if (gap < kerf - 1e-9) {
            expect(
              held,
              `kerf ${kerf} cell ${cell}: (${di},${dj}) gap ${gap} must be excluded`,
            ).toBe(true);
          } else if (!(di === 0 && dj === 0)) {
            expect(
              held,
              `kerf ${kerf} cell ${cell}: (${di},${dj}) gap ${gap} need not be excluded`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('always keeps the zero offset, so a kerf of zero still forbids overlap', () => {
    // `L(0) = 0`, so the formula alone drops it when the kerf is zero. Two
    // shapes sharing a cell is the one way conservative rasterisation lets them
    // genuinely intersect, and a kerf of zero means parts may touch, not that
    // they may be cut out of the same material twice.
    const offsets = dilationOffsets(0, 3);
    expect(offsets).toEqual([{ di: 0, dj: 0 }]);
  });

  it('a plain kerf-radius dilation would let two parts touch on the diagonal', () => {
    // `docs/plan-m7.md` §3.5 as written says to dilate the candidate "by the
    // full kerf". Read as a radius over cell centres that is unsound, and the
    // diagonal is where it fails: on a 1mm grid with a 3mm kerf, an offset of
    // (3, 3) is 4.24 cells away and so outside a 3-cell radius, yet two parts
    // sitting at it are only 2.83mm apart. This pins the counterexample so the
    // rule cannot be "simplified" back.
    const kerf = 3;
    const cell = 1;
    const naiveRadius = kerf / cell;
    expect(Math.hypot(3, 3)).toBeGreaterThan(naiveRadius);
    expect(closestApproach(3, 3, cell)).toBeLessThan(kerf);

    const inside = new Set(dilationOffsets(kerf, cell).map((o) => `${o.di},${o.dj}`));
    expect(inside.has('3,3')).toBe(true);
  });

  it('leaves the smallest legal offset exactly a kerf apart, not more', () => {
    // The element is as small as it can be while staying sound. Anything larger
    // is material spent for nothing, and on a fixture that tiles a sheet it is
    // spent a row at a time.
    const offsets = dilationOffsets(3, 3);
    const reach = Math.max(...offsets.map((o) => Math.abs(o.di)));
    expect(reach).toBe(1);
    expect(closestApproach(reach, 0, 3)).toBe(0);
    expect(closestApproach(reach + 1, 0, 3)).toBe(3);
  });
});

describe('dilate', () => {
  it('grows a mask by the element and reports the padding it added', () => {
    const mask = rasterise(SQUARE, 10);
    const { mask: grown, pad } = dilate(mask, dilationOffsets(30, 10));
    expect(pad).toBe(3);
    expect({ cols: grown.cols, rows: grown.rows }).toEqual({
      cols: mask.cols + 6,
      rows: mask.rows + 6,
    });
    // The original ground is still covered, offset by the padding.
    expect(getBit(grown, pad, pad)).toBe(true);
    expect(getBit(grown, pad - 1, pad - 1)).toBe(true);
  });

  it('leaves a mask untouched when the element is only the origin', () => {
    const mask = rasterise(SQUARE, 10);
    const { mask: grown, pad } = dilate(mask, dilationOffsets(0, 10));
    expect(pad).toBe(0);
    expect([...grown.bits]).toEqual([...mask.bits]);
  });
});

describe('the guarantee, end to end', () => {
  it('two squares at the least offset the element allows really are a kerf apart', () => {
    // The grid argument, cashed out against the exact Euclidean predicate
    // `checkResult` uses. If this ever disagrees, every nested layout the engine
    // produces is suspect.
    for (const [kerf, cell] of [
      [3, 3],
      [3, 1],
      [3.175, 3.175],
      [10, 3],
    ] as const) {
      const offsets = dilationOffsets(kerf, cell);
      const step = Math.max(...offsets.map((o) => Math.abs(o.di))) + 1;
      const side = 12 * cell;
      const square = ring([
        [0, 0],
        [side, 0],
        [side, side],
        [0, side],
      ]);
      // Two squares whose masks are `step` cells apart - the closest the element
      // permits - placed at the millimetre positions those cells stand for.
      const a = square;
      const b = square.map((p) => ({ x: p.x + (side / cell + step) * cell, y: p.y }));
      expect(polygonSeparation(a, b), `kerf ${kerf} cell ${cell}`).toBeGreaterThanOrEqual(
        kerf - 1e-9,
      );
    }
  });
});
