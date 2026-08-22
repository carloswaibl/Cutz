import { describe, expect, it } from 'vitest';
import type { Material } from '../../src/domain/types';
import { suggestMaterialId } from '../../src/ui/components/import/materialSuggestion';

function material(id: string, thickness: number): Material {
  return { id, name: id, thickness, hasGrain: true };
}

const materials: Material[] = [material('m-12', 12), material('m-18', 18), material('m-25', 25)];

describe('suggestMaterialId', () => {
  it('picks the closest material within tolerance', () => {
    expect(suggestMaterialId(18.4, materials, 'fallback')).toBe('m-18');
  });

  it('falls back when nothing is within tolerance', () => {
    expect(suggestMaterialId(50, materials, 'fallback')).toBe('fallback');
  });

  it('falls back when thickness is unknown (an SVG row)', () => {
    expect(suggestMaterialId(null, materials, 'fallback')).toBe('fallback');
  });

  it('falls back when there are no materials at all', () => {
    expect(suggestMaterialId(18, [], 'fallback')).toBe('fallback');
  });

  it('matches whichever material the thickness lands near, not always the same one', () => {
    expect(suggestMaterialId(13.4, materials, 'fallback')).toBe('m-12');
    expect(suggestMaterialId(19.4, materials, 'fallback')).toBe('m-18');
  });
});
