import { describe, expect, it } from 'vitest';
import type { Part, Stock } from '../../src/domain/types';
import { expandPartInstances, expandStockInstances } from '../../src/solver/instances';

function part(id: string, qty: number): Part {
  return {
    id,
    label: id,
    width: 100,
    height: 200,
    qty,
    materialId: 'ply18',
    rotationPolicy: 'free90',
  };
}

function stock(id: string, qty: number): Stock {
  return { id, materialId: 'ply18', width: 2440, height: 1220, qty, grainAxis: 'x' };
}

describe('expandPartInstances', () => {
  it('emits one instance per unit of qty, in declaration order', () => {
    const instances = expandPartInstances([part('a', 2), part('b', 3)]);
    expect(instances.map((i) => `${i.part.id}:${i.index}`)).toEqual([
      'a:0',
      'a:1',
      'b:0',
      'b:1',
      'b:2',
    ]);
  });

  it('shares the part reference rather than copying it', () => {
    const a = part('a', 2);
    const instances = expandPartInstances([a]);
    // The packer groups placements back onto one part id, and nothing here
    // mutates the part, so copying would only invite the two to diverge.
    expect(instances[0]?.part).toBe(a);
    expect(instances[1]?.part).toBe(a);
  });

  it('returns nothing for an empty part list', () => {
    expect(expandPartInstances([])).toEqual([]);
  });
});

describe('expandStockInstances', () => {
  it('mints ids in the canonical `stockId#index` form, from zero', () => {
    const instances = expandStockInstances([stock('ply18-sheet', 3)]);
    expect(instances.map((i) => i.id)).toEqual(['ply18-sheet#0', 'ply18-sheet#1', 'ply18-sheet#2']);
  });

  it('keeps declaration order across stock entries', () => {
    const instances = expandStockInstances([stock('b', 2), stock('a', 1)]);
    expect(instances.map((i) => i.id)).toEqual(['b#0', 'b#1', 'a#0']);
  });

  it('produces the same ids on every call, so a saved project reopens the same', () => {
    const input = [stock('a', 2), stock('b', 2)];
    expect(expandStockInstances(input)).toEqual(expandStockInstances(input));
  });
});
