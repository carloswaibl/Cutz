import { describe, expect, it } from 'vitest';
import type { Part, RotationPolicy, SolverConfig, Stock } from '../../../src/domain/types';
import { GUILLOTINE_DEFAULTS } from '../../../src/solver/guillotine';
import { greedyPack } from '../../../src/solver/guillotine/pack';
import { expandPartInstances, expandStockInstances } from '../../../src/solver/instances';

function part(
  id: string,
  width: number,
  height: number,
  qty: number,
  rotationPolicy: RotationPolicy = 'free90',
): Part {
  return { id, label: id, width, height, qty, materialId: 'ply18', rotationPolicy };
}

function stock(id: string, width: number, height: number, qty: number): Stock {
  return { id, materialId: 'ply18', width, height, qty, grainAxis: 'x' };
}

function config(overrides: Partial<SolverConfig> = {}): SolverConfig {
  return { kerf: 3, edgeTrim: 0, seed: 1, ...overrides };
}

function pack(parts: Part[], sheets: Stock[], cfg = config()) {
  return greedyPack(
    expandPartInstances(parts),
    expandStockInstances(sheets),
    cfg,
    GUILLOTINE_DEFAULTS,
  );
}

/** `x,y[,r]` per placement - compact enough to read a whole layout at a glance. */
function coords(placements: { x: number; y: number; rotated: boolean }[]): string[] {
  return placements.map((p) => `${p.x},${p.y}${p.rotated ? ',r' : ''}`);
}

describe('greedyPack', () => {
  it('tiles four squares into a sheet with kerf between them', () => {
    const result = pack([part('p', 600, 600, 4)], [stock('s', 1220, 1220, 1)]);

    expect(result.unplaced).toEqual([]);
    expect(result.sheets).toHaveLength(1);
    // 600 + 3 of kerf + 600 = 1203, inside 1220 both ways.
    expect(coords(result.sheets[0]?.layout.placements ?? [])).toEqual([
      '0,0',
      '603,0',
      '0,603',
      '603,603',
    ]);
  });

  it('charges kerf between parts but never at a sheet edge', () => {
    // The sheet is exactly 600 + kerf + 600 wide. Both parts fit only because
    // no kerf is charged at the left or right edge, where no cut happens. This
    // is the same property the `tight-fit` fixture exists to guard, in miniature.
    const result = pack([part('p', 600, 600, 2)], [stock('s', 1203, 600, 1)]);

    expect(result.unplaced).toEqual([]);
    expect(coords(result.sheets[0]?.layout.placements ?? [])).toEqual(['0,0', '603,0']);
  });

  it('packs flush with zero kerf', () => {
    const result = pack([part('p', 600, 600, 2)], [stock('s', 1200, 600, 1)], config({ kerf: 0 }));
    expect(coords(result.sheets[0]?.layout.placements ?? [])).toEqual(['0,0', '600,0']);
  });

  it('places parts inside the edge trim, not at the sheet origin', () => {
    const result = pack(
      [part('p', 600, 600, 1)],
      [stock('s', 1220, 620, 1)],
      config({ edgeTrim: 10 }),
    );
    expect(coords(result.sheets[0]?.layout.placements ?? [])).toEqual(['10,10']);
  });

  it('measures waste against the full sheet, edge trim included', () => {
    const result = pack(
      [part('p', 600, 600, 1)],
      [stock('s', 1220, 620, 1)],
      config({ edgeTrim: 10 }),
    );
    const sheet = result.sheets[0];
    // Edge trim is material the user bought and lost, so it is waste. Measuring
    // against the usable area instead would flatter every layout by a few points.
    expect(sheet?.sheetArea).toBe(1220 * 620);
    expect(sheet?.layout.wastePct).toBeCloseTo(1 - (600 * 600) / (1220 * 620), 12);
  });

  it('rotates a free90 part when that is the only way it fits', () => {
    const result = pack([part('p', 600, 300, 1)], [stock('s', 400, 700, 1)]);
    expect(coords(result.sheets[0]?.layout.placements ?? [])).toEqual(['0,0,r']);
  });

  it('leaves a grain-locked part unplaced rather than turning it', () => {
    // It would fit turned. Turning it is not on the table: the veneer would run
    // across the piece instead of along it, which no waste figure captures.
    const result = pack([part('p', 600, 300, 1, 'locked')], [stock('s', 400, 700, 1)]);
    expect(result.sheets).toEqual([]);
    expect(result.unplaced.map((i) => i.part.id)).toEqual(['p']);
  });

  it('opens a second sheet only when the first cannot take any more', () => {
    const result = pack([part('p', 600, 600, 5)], [stock('s', 1220, 1220, 2)]);
    expect(result.sheets.map((s) => s.layout.stockInstanceId)).toEqual(['s#0', 's#1']);
    expect(result.sheets[0]?.layout.placements).toHaveLength(4);
    expect(result.sheets[1]?.layout.placements).toHaveLength(1);
  });

  it('never opens a sheet it does not need', () => {
    const result = pack([part('p', 600, 600, 1)], [stock('s', 1220, 1220, 5)]);
    // Owning five sheets and using one is not 80% waste, and four empty layouts
    // would say exactly that.
    expect(result.sheets).toHaveLength(1);
  });

  it('opens the largest usable sheet first, whatever order stock was declared in', () => {
    const result = pack(
      [part('p', 600, 600, 1)],
      [stock('small', 700, 700, 1), stock('large', 1220, 1220, 1)],
    );
    expect(result.sheets.map((s) => s.layout.stockInstanceId)).toEqual(['large#0']);
  });

  it('reports a shortfall when stock runs out', () => {
    const result = pack([part('p', 600, 600, 6)], [stock('s', 1220, 1220, 1)]);
    expect(result.sheets[0]?.layout.placements).toHaveLength(4);
    expect(result.unplaced.map((i) => i.part.id)).toEqual(['p', 'p']);
  });

  it('reports every instance of a part too large for any sheet', () => {
    const result = pack([part('p', 5000, 5000, 3)], [stock('s', 1220, 1220, 1)]);
    expect(result.sheets).toEqual([]);
    expect(result.unplaced).toHaveLength(3);
  });

  it('carries a part that fits no open sheet forward to a later one', () => {
    // The small part is placed first and fills the small sheet; the large part
    // has to wait for a sheet that can hold it rather than being given up on.
    const result = pack(
      [part('big', 1000, 1000, 1), part('small', 600, 600, 1)],
      [stock('a', 1220, 1220, 1), stock('b', 700, 700, 1)],
    );
    expect(result.unplaced).toEqual([]);
    expect(result.sheets).toHaveLength(2);
  });

  it('skips a sheet whose edge trim leaves no usable area', () => {
    const result = pack(
      [part('p', 100, 100, 1)],
      [stock('tiny', 100, 100, 1), stock('big', 1220, 1220, 1)],
      config({ edgeTrim: 60 }),
    );
    expect(result.sheets.map((s) => s.layout.stockInstanceId)).toEqual(['big#0']);
  });

  it('returns nothing at all when there is no stock', () => {
    const result = pack([part('p', 600, 600, 2)], []);
    expect(result.sheets).toEqual([]);
    expect(result.unplaced).toHaveLength(2);
  });

  it('is deterministic across repeated runs', () => {
    const parts = [part('a', 600, 400, 7), part('b', 300, 900, 5)];
    const sheets = [stock('s', 2440, 1220, 3)];
    expect(pack(parts, sheets)).toEqual(pack(parts, sheets));
  });

  it('does not mutate the instances it was given', () => {
    const parts = [part('a', 600, 400, 3)];
    const sheets = [stock('s', 2440, 1220, 1)];
    const partInstances = expandPartInstances(parts);
    const stockInstances = expandStockInstances(sheets);
    const partsBefore = structuredClone(partInstances);
    const stockBefore = structuredClone(stockInstances);

    greedyPack(partInstances, stockInstances, config(), GUILLOTINE_DEFAULTS);

    expect(partInstances).toEqual(partsBefore);
    expect(stockInstances).toEqual(stockBefore);
  });
});
