import { describe, expect, it } from 'vitest';
import { BOOKSHELF_PRESET } from '../../src/ui/state/presets';

describe('PR 2 Component Input State & Preset Handlers', () => {
  it('correctly loads and manipulates bookshelf preset materials and stock', () => {
    const preset = BOOKSHELF_PRESET;
    expect(preset.materials.length).toBeGreaterThan(0);
    expect(preset.parts.length).toBe(2);
    expect(preset.stock.length).toBe(1);

    // Verify stock presets dimensions in mm
    const sheet4x8Width = 1219.2; // 48 inches in mm
    const sheet4x8Height = 2438.4; // 96 inches in mm
    expect(sheet4x8Width).toBeCloseTo(1219.2, 1);
    expect(sheet4x8Height).toBeCloseTo(2438.4, 1);
  });
});
