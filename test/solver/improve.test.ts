import { describe, expect, it } from 'vitest';
import { checkResult } from '../../src/domain/validate';
import { SolverInputError } from '../../src/solver/errors';
import { ImprovementSolver, improveGuillotine } from '../../src/solver/improve';
import { guillotineFixtures, loadFixtures } from '../fixtures/index';

describe('ImprovementSolver / improveGuillotine', () => {
  it('implements the Solver interface', () => {
    expect(typeof ImprovementSolver.solve).toBe('function');
  });

  it('produces 100% deep-equal results across two identical runs', () => {
    const fixture = loadFixtures()[0];
    if (!fixture) throw new Error('No fixture found');

    const result1 = improveGuillotine(fixture.parts, fixture.stock, fixture.config);
    const result2 = improveGuillotine(fixture.parts, fixture.stock, fixture.config);

    expect(result1).toEqual(result2);
  });

  it('satisfies all Result invariants on benchmark fixtures', () => {
    // Guillotine fixtures only: a nest fixture's config asks for nest mode, so
    // checking a table-saw layout against it would measure the saw's rectangles
    // with a router's polygon rules and fail every time - correctly.
    for (const fixture of guillotineFixtures()) {
      const result = improveGuillotine(fixture.parts, fixture.stock, fixture.config);
      const outcome = checkResult(result, {
        parts: fixture.parts,
        stock: fixture.stock,
        config: fixture.config,
      });

      expect(outcome.violations).toEqual([]);
      expect(outcome.unverifiedSheets).toEqual([]);
      expect(outcome.status).toBe('valid');
    }
  });

  it('supports fast, balanced, and thorough effort levels', () => {
    const fixture = loadFixtures()[0];
    if (!fixture) throw new Error('No fixture found');

    const fast = improveGuillotine(fixture.parts, fixture.stock, {
      ...fixture.config,
      effort: 'fast',
    });
    const balanced = improveGuillotine(fixture.parts, fixture.stock, {
      ...fixture.config,
      effort: 'balanced',
    });
    const thorough = improveGuillotine(fixture.parts, fixture.stock, {
      ...fixture.config,
      effort: 'thorough',
    });

    expect(fast.layouts.length).toBeGreaterThan(0);
    expect(balanced.layouts.length).toBeGreaterThan(0);
    expect(thorough.layouts.length).toBeGreaterThan(0);
  });

  it('throws SolverInputError on invalid inputs', () => {
    const badPart = {
      id: 'p1',
      label: 'Bad',
      width: -10,
      height: 10,
      qty: 1,
      materialId: 'm1',
      rotationPolicy: 'free90' as const,
    };
    const badStock = {
      id: 's1',
      materialId: 'm1',
      width: 1000,
      height: 1000,
      qty: 1,
      grainAxis: 'x' as const,
    };
    const config = { kerf: 3, edgeTrim: 0, seed: 42 };

    expect(() => improveGuillotine([badPart], [badStock], config)).toThrow(SolverInputError);
  });
});
