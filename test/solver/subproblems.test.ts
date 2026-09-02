import { describe, expect, it } from 'vitest';
import type { Part, SolverConfig, Stock } from '../../src/domain/types';
import { SolverInputError } from '../../src/solver/errors';
import type { PartInstance, StockInstance } from '../../src/solver/instances';
import { groupByMaterial, solveByMaterial, summariseUnplaced } from '../../src/solver/subproblems';
import type { PackedResult } from '../../src/solver/types';

function part(id: string, overrides: Partial<Part> = {}): Part {
  return {
    id,
    label: id,
    width: 600,
    height: 400,
    qty: 1,
    materialId: 'ply18',
    rotationPolicy: 'free90',
    ...overrides,
  };
}

function stock(id: string, overrides: Partial<Stock> = {}): Stock {
  return {
    id,
    materialId: 'ply18',
    width: 2440,
    height: 1220,
    qty: 1,
    grainAxis: 'x',
    ...overrides,
  };
}

const CONFIG: SolverConfig = { kerf: 3, edgeTrim: 5, seed: 1 };

/**
 * A stand-in engine that places nothing and opens no sheets.
 *
 * The driver is the unit under test here, not a packer: what matters is which
 * subproblems it hands out, in what order, and how it assembles the answer.
 */
function shortfallEngine(): {
  packer: (p: readonly PartInstance[], s: readonly StockInstance[]) => PackedResult;
  calls: { parts: string[]; stock: string[] }[];
} {
  const calls: { parts: string[]; stock: string[] }[] = [];
  return {
    calls,
    packer: (parts, stockInstances) => {
      calls.push({
        parts: parts.map((i) => i.part.id),
        stock: stockInstances.map((i) => i.id),
      });
      return { sheets: [], unplaced: [...parts] };
    },
  };
}

describe('groupByMaterial', () => {
  it('groups in the order the materials first appear', () => {
    const groups = groupByMaterial([
      part('a', { materialId: 'mdf' }),
      part('b', { materialId: 'ply18' }),
      part('c', { materialId: 'mdf' }),
    ]);

    expect([...groups.keys()]).toEqual(['mdf', 'ply18']);
    expect(groups.get('mdf')?.map((p) => p.id)).toEqual(['a', 'c']);
  });
});

describe('summariseUnplaced', () => {
  it('reports shortfall in part-declaration order, not the order the packer gave up', () => {
    const first = part('first', { qty: 2 });
    const second = part('second');
    const third = part('third');

    const summary = summariseUnplaced(
      [
        { part: third, index: 0 },
        { part: first, index: 1 },
        { part: first, index: 0 },
      ],
      [first, second, third],
    );

    // `second` was fully placed, so it is absent rather than reported as zero.
    expect(summary).toEqual([
      { partId: 'first', qty: 2 },
      { partId: 'third', qty: 1 },
    ]);
  });
});

describe('solveByMaterial', () => {
  it('hands each engine run one material, never a mix', () => {
    const { packer, calls } = shortfallEngine();

    solveByMaterial(
      [part('a', { materialId: 'mdf' }), part('b'), part('c', { materialId: 'mdf' })],
      [stock('s-ply'), stock('s-mdf', { materialId: 'mdf' })],
      CONFIG,
      () => packer,
    );

    expect(calls).toEqual([
      { parts: ['a', 'c'], stock: ['s-mdf#0'] },
      { parts: ['b'], stock: ['s-ply#0'] },
    ]);
  });

  it('expands quantities into instances before the engine sees them', () => {
    const { packer, calls } = shortfallEngine();

    solveByMaterial([part('a', { qty: 3 })], [stock('s', { qty: 2 })], CONFIG, () => packer);

    expect(calls[0]).toEqual({ parts: ['a', 'a', 'a'], stock: ['s#0', 's#1'] });
  });

  it('gives a material with no stock an empty sheet list rather than skipping it', () => {
    const { packer, calls } = shortfallEngine();

    const result = solveByMaterial(
      [part('a', { materialId: 'mdf' })],
      [stock('s-ply')],
      CONFIG,
      () => packer,
    );

    expect(calls).toEqual([{ parts: ['a'], stock: [] }]);
    expect(result.unplacedParts).toEqual([{ partId: 'a', qty: 1 }]);
  });

  it('reports no waste when nothing was cut', () => {
    const { packer } = shortfallEngine();

    const result = solveByMaterial([part('a')], [stock('s')], CONFIG, () => packer);

    // Not 100%: that is the number you would show a user who has not entered
    // any stock yet, and it is worse than useless.
    expect(result.totalWastePct).toBe(0);
    expect(result.layouts).toEqual([]);
  });

  it('computes waste over the sheets that were actually opened', () => {
    const result = solveByMaterial([part('a')], [stock('s')], CONFIG, () => () => ({
      sheets: [
        {
          layout: { stockInstanceId: 's#0', placements: [], wastePct: 0.75 },
          placedArea: 250,
          sheetArea: 1000,
        },
      ],
      unplaced: [],
    }));

    expect(result.totalWastePct).toBeCloseTo(0.75, 10);
    expect(result.layouts).toHaveLength(1);
  });

  it('validates before the engine is even constructed', () => {
    let built = false;

    expect(() =>
      solveByMaterial([part('a', { width: -1 })], [stock('s')], CONFIG, () => {
        built = true;
        return shortfallEngine().packer;
      }),
    ).toThrow(SolverInputError);

    // The factory is where an engine seeds its generator. Running it against a
    // config the validator is about to reject would throw a bare Error over the
    // typed issues the caller is owed.
    expect(built).toBe(false);
  });

  it('passes warnings through and solves anyway', () => {
    const { packer } = shortfallEngine();

    // A part too large for any sheet is a warning, not an error: the honest
    // answer is a shortfall, not a refusal.
    const result = solveByMaterial(
      [part('huge', { width: 9000, height: 9000 })],
      [stock('s')],
      CONFIG,
      () => packer,
    );

    expect(result.unplacedParts).toEqual([{ partId: 'huge', qty: 1 }]);
  });
});
