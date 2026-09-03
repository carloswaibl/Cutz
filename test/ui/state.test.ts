import { describe, expect, it } from 'vitest';
import { buildCutPlans } from '../../src/domain/cutplan';
import { boundsOf, polygonArea } from '../../src/domain/polygon';
import type { Part } from '../../src/domain/types';
import { DEFAULT_ROTATION_STEPS, solverMode } from '../../src/domain/validate';
import { solve } from '../../src/solver/index';
import { BOOKSHELF_PRESET, DRAWER_BOXES_PRESET, PRESETS } from '../../src/ui/state/presets';
import type { AppState } from '../../src/ui/state/types';
import { cutListReducer } from '../../src/ui/state/useCutListState';

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

/**
 * The machine selector, from the reducer's side.
 *
 * `SET_CONFIG` already took a `Partial<SolverConfig>` before M7 PR 8, so the
 * selector needed no new action - but that is a claim worth pinning rather than
 * assuming, because the shallow merge is what keeps kerf, trim and seed alive
 * across a machine change. A user who switches to the router, looks at the
 * result and switches back must get the layout they started with.
 */
describe('SET_CONFIG carries the machine choice', () => {
  const base: AppState = {
    displayUnit: 'imperial-fraction',
    fractionDenominator: 16,
    materials: BOOKSHELF_PRESET.materials,
    parts: BOOKSHELF_PRESET.parts,
    stock: BOOKSHELF_PRESET.stock,
    config: BOOKSHELF_PRESET.config,
    activeSheetIndex: 0,
    hoveredPartId: null,
    selectedMaterialId: 'all',
    showCutSequence: true,
    projectGeneration: 0,
  };

  it('defaults to the table saw, so every pre-M7 project opens as one', () => {
    expect(base.config.mode).toBeUndefined();
    expect(solverMode(base.config)).toBe('guillotine');
  });

  it('sets the mode without disturbing the rest of the config', () => {
    const next = cutListReducer(base, { type: 'SET_CONFIG', config: { mode: 'nest' } });
    expect(solverMode(next.config)).toBe('nest');
    expect(next.config.kerf).toBe(base.config.kerf);
    expect(next.config.edgeTrim).toBe(base.config.edgeTrim);
    expect(next.config.seed).toBe(base.config.seed);
    expect(next.config.effort).toBe(base.config.effort);
  });

  it('round-trips back to the saw with the original config intact', () => {
    const there = cutListReducer(base, { type: 'SET_CONFIG', config: { mode: 'nest' } });
    const back = cutListReducer(there, { type: 'SET_CONFIG', config: { mode: 'guillotine' } });
    expect(back.config).toEqual({ ...base.config, mode: 'guillotine' });
  });

  it('carries the rotation step count', () => {
    const next = cutListReducer(base, { type: 'SET_CONFIG', config: { rotationSteps: 12 } });
    expect(next.config.rotationSteps).toBe(12);
    // Unset means the engine's own default, not zero orientations.
    expect(base.config.rotationSteps ?? DEFAULT_ROTATION_STEPS).toBe(4);
  });

  it('produces a new config object, which is what re-triggers the solve', () => {
    // `useSolve` depends on `config` by identity. A reducer that mutated in
    // place would change the machine and leave the old layout on screen.
    const next = cutListReducer(base, { type: 'SET_CONFIG', config: { mode: 'nest' } });
    expect(next.config).not.toBe(base.config);
  });
});

describe('LOAD_PROJECT', () => {
  const state: AppState = {
    displayUnit: 'imperial-fraction',
    fractionDenominator: 16,
    materials: BOOKSHELF_PRESET.materials,
    parts: BOOKSHELF_PRESET.parts,
    stock: BOOKSHELF_PRESET.stock,
    config: BOOKSHELF_PRESET.config,
    activeSheetIndex: 2,
    hoveredPartId: 'p-side',
    selectedMaterialId: 'mat-ply-34',
    showCutSequence: true,
    projectGeneration: 0,
  };

  it('replaces the seven persisted fields with the loaded project', () => {
    const next = cutListReducer(state, {
      type: 'LOAD_PROJECT',
      project: {
        displayUnit: 'metric-mm',
        fractionDenominator: 1,
        materials: DRAWER_BOXES_PRESET.materials,
        parts: DRAWER_BOXES_PRESET.parts,
        stock: DRAWER_BOXES_PRESET.stock,
        config: DRAWER_BOXES_PRESET.config,
        showCutSequence: false,
      },
    });

    expect(next.displayUnit).toBe('metric-mm');
    expect(next.materials).toBe(DRAWER_BOXES_PRESET.materials);
    expect(next.parts).toBe(DRAWER_BOXES_PRESET.parts);
    expect(next.stock).toBe(DRAWER_BOXES_PRESET.stock);
    expect(next.config).toBe(DRAWER_BOXES_PRESET.config);
    expect(next.showCutSequence).toBe(false);
  });

  it('resets transient UI state so a freshly loaded project starts clean', () => {
    const next = cutListReducer(state, {
      type: 'LOAD_PROJECT',
      project: {
        displayUnit: 'imperial-fraction',
        fractionDenominator: 16,
        materials: DRAWER_BOXES_PRESET.materials,
        parts: DRAWER_BOXES_PRESET.parts,
        stock: DRAWER_BOXES_PRESET.stock,
        config: DRAWER_BOXES_PRESET.config,
        showCutSequence: true,
      },
    });

    expect(next.activeSheetIndex).toBe(0);
    expect(next.hoveredPartId).toBeNull();
    expect(next.selectedMaterialId).toBe('all');
  });

  /**
   * `useSolve` keys its "throw the previous layout away" reset off this, so a
   * project switch never leaves the outgoing project's diagram on screen under
   * the incoming project's parts. Two projects made from the same template
   * share part and stock ids, so that diagram would resolve and render rather
   * than being filtered out. Only a whole-project load counts - an edit must
   * keep the previous layout visible while the next solve runs.
   */
  it('advances projectGeneration on load, and never on an edit', () => {
    const loaded = cutListReducer(state, {
      type: 'LOAD_PROJECT',
      project: {
        displayUnit: 'imperial-fraction',
        fractionDenominator: 16,
        materials: DRAWER_BOXES_PRESET.materials,
        parts: DRAWER_BOXES_PRESET.parts,
        stock: DRAWER_BOXES_PRESET.stock,
        config: DRAWER_BOXES_PRESET.config,
        showCutSequence: true,
      },
    });
    expect(loaded.projectGeneration).toBe(state.projectGeneration + 1);

    const edited = cutListReducer(loaded, {
      type: 'UPDATE_PART',
      id: loaded.parts[0]?.id ?? '',
      part: { label: 'Renamed' },
    });
    expect(edited.projectGeneration).toBe(loaded.projectGeneration);
  });
});

/**
 * An imported part carries a polygon the user never sees and cannot edit, and
 * `Part.outline` is defined as spanning exactly the part's `width` x `height` -
 * an invariant `validateInputs` enforces as an **error**, which blocks solving
 * for every material at once. Retyping a width in the parts table is therefore
 * the one ordinary edit that could strand one. `docs/plan-m7.md` §5 PR 4.
 */
describe('UPDATE_PART and imported outlines', () => {
  const bracket: Part = {
    id: 'p-bracket',
    label: 'Bracket',
    width: 600,
    height: 300,
    qty: 1,
    materialId: 'mat-ply-34',
    rotationPolicy: 'free90',
    outline: [
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 150 },
      { x: 300, y: 150 },
      { x: 300, y: 300 },
      { x: 0, y: 300 },
    ],
  };

  const state: AppState = {
    displayUnit: 'metric-mm',
    fractionDenominator: 16,
    materials: BOOKSHELF_PRESET.materials,
    parts: [bracket],
    stock: BOOKSHELF_PRESET.stock,
    config: BOOKSHELF_PRESET.config,
    activeSheetIndex: 0,
    hoveredPartId: null,
    selectedMaterialId: 'all',
    showCutSequence: true,
    projectGeneration: 0,
  };

  function updated(patch: Partial<Part>): Part {
    const next = cutListReducer(state, { type: 'UPDATE_PART', id: 'p-bracket', part: patch });
    const part = next.parts[0];
    if (!part) throw new Error('the part disappeared');
    return part;
  }

  it('stretches the outline onto a retyped width, rather than stranding it', () => {
    const part = updated({ width: 800 });
    expect(boundsOf(part.outline ?? [])).toEqual({ x: 0, y: 0, width: 800, height: 300 });
  });

  it('keeps the shape concave rather than dropping it back to a rectangle', () => {
    // A part quietly turning back into a rectangle is the kind of change a
    // woodworker discovers at the router.
    const part = updated({ width: 800, height: 500 });
    expect(part.outline).toHaveLength(6);
    expect(polygonArea(part.outline ?? [])).toBeLessThan(800 * 500);
  });

  it('leaves an edit that is not a resize completely alone', () => {
    expect(updated({ label: 'Gusset' }).outline).toEqual(bracket.outline);
  });

  it('does not invent an outline for a part that never had one', () => {
    const { outline: _dropped, ...rectangular } = bracket;
    const plain: AppState = { ...state, parts: [rectangular] };
    const next = cutListReducer(plain, {
      type: 'UPDATE_PART',
      id: 'p-bracket',
      part: { width: 800 },
    });
    expect(next.parts[0]?.outline).toBeUndefined();
  });
});
