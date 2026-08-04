import { describe, expect, it } from 'vitest';
import type { Part, Stock } from '../src/domain/types';

/**
 * Scaffold smoke test. Its real job is to prove the headless test path works:
 * domain/ imports cleanly in a plain Node environment with no DOM present.
 * Replace this with the solver invariant suite in M1.
 */
describe('scaffold', () => {
  it('loads domain types in a DOM-free environment', () => {
    expect(typeof globalThis.document).toBe('undefined');

    const part: Part = {
      id: 'p1',
      label: 'Shelf',
      width: 800,
      height: 300,
      qty: 4,
      materialId: 'ply18',
      rotationPolicy: 'locked',
    };

    const stock: Stock = {
      id: 's1',
      materialId: 'ply18',
      width: 2440,
      height: 1220,
      qty: 1,
      grainAxis: 'x',
    };

    expect(part.materialId).toBe(stock.materialId);
  });
});
