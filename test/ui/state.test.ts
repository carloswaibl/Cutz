import { describe, expect, it } from 'vitest';
import { solve } from '../../src/solver/index';
import { BOOKSHELF_PRESET, PRESETS } from '../../src/ui/state/presets';

describe('UI State Presets & Domain Integration', () => {
  it('has valid preset projects that solve without errors', () => {
    expect(PRESETS.bookshelf).toBeDefined();
    expect(PRESETS['cabinet-carcass']).toBeDefined();
    expect(PRESETS['drawer-boxes']).toBeDefined();

    for (const [key, preset] of Object.entries(PRESETS)) {
      const res = solve(preset.parts, preset.stock, preset.config);
      expect(res.layouts.length, `Preset ${key} should produce layouts`).toBeGreaterThan(0);
      expect(res.totalWastePct, `Preset ${key} should have reasonable waste`).toBeLessThan(0.3);
    }
  });

  it('bookshelf preset matches expected default values', () => {
    expect(BOOKSHELF_PRESET.materials).toHaveLength(1);
    expect(BOOKSHELF_PRESET.parts).toHaveLength(2);
    expect(BOOKSHELF_PRESET.stock).toHaveLength(1);
    expect(BOOKSHELF_PRESET.config.kerf).toBeCloseTo(3.175, 2);
  });
});
