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

  it('slugs the project and material names', () => {
    expect(
      sheetFileName({
        projectName: 'Bookshelf',
        sheetNumber: 2,
        material: material('18mm Birch Ply'),
        extension: 'svg',
      }),
    ).toBe('cutz-bookshelf-sheet-2-18mm-birch-ply.svg');
  });

  it('collapses punctuation runs in both names', () => {
    expect(
      sheetFileName({
        projectName: 'Kitchen (Remodel)',
        sheetNumber: 1,
        material: material('MDF (3/4") -- offcut'),
        extension: 'dxf',
      }),
    ).toBe('cutz-kitchen-remodel-sheet-1-mdf-3-4-offcut.dxf');
  });

  it('falls back when the material name slugs to nothing', () => {
    expect(
      sheetFileName({
        projectName: 'Bookshelf',
        sheetNumber: 3,
        material: material('...'),
        extension: 'svg',
      }),
    ).toBe('cutz-bookshelf-sheet-3.svg');
  });

  it('falls back when the project name slugs to nothing', () => {
    expect(
      sheetFileName({
        projectName: '...',
        sheetNumber: 3,
        material: material('18mm Birch Ply'),
        extension: 'svg',
      }),
    ).toBe('cutz-sheet-3-18mm-birch-ply.svg');
  });

  it('falls back to the plain sheet name when both slug to nothing', () => {
    expect(
      sheetFileName({
        projectName: '...',
        sheetNumber: 3,
        material: material('...'),
        extension: 'svg',
      }),
    ).toBe('cutz-sheet-3.svg');
  });
});
