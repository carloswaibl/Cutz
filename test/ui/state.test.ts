import { describe, expect, it } from 'vitest';
import { buildCutPlans } from '../../src/domain/cutplan';
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

/**
 * `useCutListState` builds cut plans eagerly alongside the solver result. The
 * hook itself needs a React renderer to exercise, but the two facts the UI
 * depends on are properties of `buildCutPlans` over real presets, and those are
 * testable here in plain Node: every preset yields one plan per sheet, and a
 * result that does not belong to its project throws rather than returning an
 * empty cut list the user would read as "no cuts needed".
 */
describe('Cut plans behind the app state', () => {
  it('builds one plan per layout for every preset', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      const result = solve(preset.parts, preset.stock, preset.config);
      const plans = buildCutPlans(result, {
        parts: preset.parts,
        stock: preset.stock,
        materials: preset.materials,
        config: preset.config,
      });

      expect(plans, `Preset ${key} should plan every sheet`).toHaveLength(result.layouts.length);
      for (const [index, plan] of plans.entries()) {
        expect(plan.stockInstanceId).toBe(result.layouts[index]?.stockInstanceId);
        expect(plan.status, `Preset ${key} sheet ${index + 1} should be cuttable`).toBe('complete');
        expect(plan.steps.length).toBeGreaterThan(0);
      }
    }
  });

  it('throws on a result that names stock the project does not have', () => {
    const preset = BOOKSHELF_PRESET;
    const result = solve(preset.parts, preset.stock, preset.config);

    expect(() =>
      buildCutPlans(result, {
        parts: preset.parts,
        stock: [],
        materials: preset.materials,
        config: preset.config,
      }),
    ).toThrow(/stock entry that is not in the project/);
  });
});
