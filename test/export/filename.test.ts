import { describe, expect, it } from 'vitest';
import type { Material } from '../../src/domain/types';
import { sheetFileName } from '../../src/export/filename';

describe('sheetFileName', () => {
  const material = (name: string): Material => ({
    id: 'm',
    name,
    thickness: 18,
    hasGrain: true,
  });

  it('slugs the material name', () => {
    expect(
      sheetFileName({ sheetNumber: 2, material: material('18mm Birch Ply'), extension: 'svg' }),
    ).toBe('cutz-sheet-2-18mm-birch-ply.svg');
  });

  it('collapses punctuation runs', () => {
    expect(
      sheetFileName({
        sheetNumber: 1,
        material: material('MDF (3/4") -- offcut'),
        extension: 'dxf',
      }),
    ).toBe('cutz-sheet-1-mdf-3-4-offcut.dxf');
  });

  it('falls back when a name slugs to nothing', () => {
    expect(sheetFileName({ sheetNumber: 3, material: material('...'), extension: 'svg' })).toBe(
      'cutz-sheet-3.svg',
    );
  });
});
