import { describe, expect, it } from 'vitest';
import type { Part } from '../../src/domain/types';
import { BOOKSHELF_PRESET } from '../../src/ui/state/presets';
import type { AppState } from '../../src/ui/state/types';
import { cutListReducer } from '../../src/ui/state/useCutListState';

function baseState(): AppState {
  return {
    displayUnit: 'imperial-fraction',
    fractionDenominator: 16,
    materials: BOOKSHELF_PRESET.materials,
    parts: BOOKSHELF_PRESET.parts,
    stock: BOOKSHELF_PRESET.stock,
    config: BOOKSHELF_PRESET.config,
    activeSheetIndex: 2,
    hoveredPartId: null,
    selectedMaterialId: 'all',
    showCutSequence: true,
    projectGeneration: 0,
  };
}

function importedPart(overrides: Partial<Part> = {}): Part {
  return {
    id: 'imported-1',
    label: 'Imported Shelf',
    width: 600,
    height: 300,
    qty: 4,
    materialId: BOOKSHELF_PRESET.materials[0]?.id ?? 'mat-ply-34',
    rotationPolicy: 'free90',
    ...overrides,
  };
}

describe('IMPORT_PARTS', () => {
  it('appends onto the existing parts list without disturbing it', () => {
    const state = baseState();
    const incoming = [importedPart()];
    const next = cutListReducer(state, { type: 'IMPORT_PARTS', parts: incoming, mode: 'append' });

    expect(next.parts).toEqual([...state.parts, ...incoming]);
  });

  it('replaces the existing parts list entirely', () => {
    const state = baseState();
    const incoming = [importedPart(), importedPart({ id: 'imported-2', label: 'Imported Side' })];
    const next = cutListReducer(state, { type: 'IMPORT_PARTS', parts: incoming, mode: 'replace' });

    expect(next.parts).toEqual(incoming);
  });

  it('resets the active sheet index, since the sheet list is about to change', () => {
    const state = baseState();
    const next = cutListReducer(state, {
      type: 'IMPORT_PARTS',
      parts: [importedPart()],
      mode: 'append',
    });

    expect(next.activeSheetIndex).toBe(0);
  });

  it('leaves materials, stock and config untouched', () => {
    const state = baseState();
    const next = cutListReducer(state, {
      type: 'IMPORT_PARTS',
      parts: [importedPart()],
      mode: 'replace',
    });

    expect(next.materials).toBe(state.materials);
    expect(next.stock).toBe(state.stock);
    expect(next.config).toBe(state.config);
  });
});
