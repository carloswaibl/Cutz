import { describe, expect, it } from 'vitest';
import { placementRect } from '../../../src/domain/polygon';
import type { Part, SolverConfig, Stock } from '../../../src/domain/types';
import { checkResult } from '../../../src/domain/validate';
import { SolverInputError } from '../../../src/solver/errors';
import { GuillotineSolver, packGuillotine } from '../../../src/solver/guillotine';
import { type Fixture, guillotineFixtures } from '../../fixtures/index';

// Every claim in this file is about a table saw - decomposability, M1's waste
// bar, beating a naive row packer - so it asks for the fixtures a table saw is
// meant to cut. M7's nest fixtures are triangles and hooks; the saw can cut
// their bounding boxes and does, wastefully, which is the whole point of them.
const FIXTURES = guillotineFixtures();

/**
 * What a throwaway row packer achieved on each fixture, recorded in the M1 plan
 * when the fixtures landed in PR 3.
 *
 * This is a floor, not a target. A free-rectangle packer that does *worse* than
 * a naive shelf heuristic is wrong - the fixture is not too hard, the packer has
 * a bug. Pinning it here means that regression is caught by the test suite
 * rather than noticed later by someone reading a benchmark table.
 */
const NAIVE_FLOOR: Record<string, { sheets: number; wastePct: number }> = {
  bookshelf: { sheets: 3, wastePct: 4.9 },
  'cabinet-carcass': { sheets: 5, wastePct: 10.2 },
  'closet-organizer': { sheets: 3, wastePct: 2.8 },
  'drawer-boxes': { sheets: 3, wastePct: 9.8 },
  'grain-locked-panels': { sheets: 3, wastePct: 3.5 },
  'mixed-stock': { sheets: 3, wastePct: 3.4 },
  'tight-fit': { sheets: 1, wastePct: 0.7 },
  'workbench-cabinet': { sheets: 3, wastePct: 4.3 },
};

/** The M1 exit bar, from `docs/plan-m1.md` §1. */
const WASTE_BAR = 0.15;

function solve(fixture: Fixture) {
  return GuillotineSolver.solve(fixture.parts, fixture.stock, fixture.config);
}

function check(fixture: Fixture, result: ReturnType<typeof solve>) {
  return checkResult(result, {
    parts: fixture.parts,
    stock: fixture.stock,
    config: fixture.config,
  });
}

function part(id: string, overrides: Partial<Part> = {}): Part {
  return {
    id,
    label: id,
    width: 600,
    height: 400,
    qty: 1,
    materialId: 'ply18',
    rotationPolicy: 'free90',
    ...overrides,
  };
}

function stock(id: string, overrides: Partial<Stock> = {}): Stock {
  return {
    id,
    materialId: 'ply18',
    width: 2440,
    height: 1220,
    qty: 1,
    grainAxis: 'x',
    ...overrides,
  };
}

const CONFIG: SolverConfig = { kerf: 3, edgeTrim: 5, seed: 1 };

describe.each(FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
  'the guillotine solver on %s',
  (_name, fixture) => {
    const result = solve(fixture);
    const outcome = check(fixture, result);

    it('satisfies every invariant', () => {
      // `unverified` fails as loudly as `invalid`. A guillotine search that ran
      // out of budget has proved nothing, and treating "I do not know" as "fine"
      // is how an uncuttable layout reaches someone standing at a table saw.
      expect(outcome.violations).toEqual([]);
      expect(outcome.unverifiedSheets).toEqual([]);
      expect(outcome.status).toBe('valid');
    });

    it('is deterministic', () => {
      expect(solve(fixture)).toEqual(result);
    });

    if (fixture.role === 'correctness') {
      it('reports exactly the expected shortfall', () => {
        expect(result.unplacedParts).toEqual(fixture.expectedUnplaced);
      });
    } else {
      it('places every part', () => {
        expect(result.unplacedParts).toEqual([]);
      });

      it(`comes in under the ${WASTE_BAR * 100}% waste bar`, () => {
        expect(result.totalWastePct).toBeLessThan(WASTE_BAR);
      });

      it('is no worse than the naive row packer PR 3 measured', () => {
        const floor = NAIVE_FLOOR[fixture.name];
        expect(floor).toBeDefined();
        expect(result.layouts.length).toBeLessThanOrEqual(floor?.sheets ?? 0);
        // The recorded figures are to one decimal place, so allow that much.
        expect(result.totalWastePct * 100).toBeLessThanOrEqual((floor?.wastePct ?? 0) + 0.05);
      });
    }
  },
);

describe('the guillotine solver', () => {
  it('never mixes two materials on one sheet', () => {
    // Not covered by the invariant check alone: that verifies each placement
    // matches its sheet, and this verifies the subproblems really were solved
    // independently rather than happening to agree.
    for (const fixture of FIXTURES) {
      const stockById = new Map(fixture.stock.map((sheet) => [sheet.id, sheet]));
      const partsById = new Map(fixture.parts.map((p) => [p.id, p]));
      for (const layout of solve(fixture).layouts) {
        const materials = new Set(
          layout.placements.map((p) => partsById.get(p.partId)?.materialId),
        );
        expect(materials.size).toBeLessThanOrEqual(1);
        const sheetId = layout.stockInstanceId.slice(0, layout.stockInstanceId.lastIndexOf('#'));
        if (materials.size === 1) {
          expect([...materials][0]).toBe(stockById.get(sheetId)?.materialId);
        }
      }
    }
  });

  it('never rotates a grain-locked part in any fixture', () => {
    for (const fixture of FIXTURES) {
      const locked = new Set(
        fixture.parts.filter((p) => p.rotationPolicy === 'locked').map((p) => p.id),
      );
      for (const layout of solve(fixture).layouts) {
        for (const placement of layout.placements) {
          if (locked.has(placement.partId)) expect(placement.angleDeg).toBe(0);
        }
      }
    }
  });

  it('keeps every placement inside the usable area of its sheet', () => {
    // Redundant with invariant 2, deliberately: it is cheap, and it reads as an
    // assertion about the packer rather than about the checker.
    for (const fixture of FIXTURES) {
      const partsById = new Map(fixture.parts.map((p) => [p.id, p]));
      for (const layout of solve(fixture).layouts) {
        for (const placement of layout.placements) {
          const target = partsById.get(placement.partId);
          expect(target).toBeDefined();
          if (target === undefined) continue;
          const rect = placementRect(target, placement);
          expect(rect.x).toBeGreaterThanOrEqual(fixture.config.edgeTrim);
          expect(rect.y).toBeGreaterThanOrEqual(fixture.config.edgeTrim);
        }
      }
    }
  });

  it('does not mutate the parts or stock it was given', () => {
    for (const fixture of FIXTURES) {
      const parts = structuredClone(fixture.parts);
      const sheets = structuredClone(fixture.stock);
      GuillotineSolver.solve(parts, sheets, fixture.config);
      expect(parts).toEqual(fixture.parts);
      expect(sheets).toEqual(fixture.stock);
    }
  });

  it('reports zero waste rather than total waste when nothing was cut', () => {
    // A user who has entered parts but no matching stock should not be told
    // they wasted 100% of a sheet they never owned.
    const result = packGuillotine([part('p')], [stock('s', { materialId: 'mdf12' })], CONFIG);
    expect(result.layouts).toEqual([]);
    expect(result.totalWastePct).toBe(0);
    expect(result.unplacedParts).toEqual([{ partId: 'p', qty: 1 }]);
  });

  it('summarises the shortfall in the order parts were declared', () => {
    const result = packGuillotine(
      [part('z', { qty: 2, width: 5000 }), part('a', { qty: 1, width: 5000 })],
      [stock('s')],
      CONFIG,
    );
    expect(result.unplacedParts).toEqual([
      { partId: 'z', qty: 2 },
      { partId: 'a', qty: 1 },
    ]);
  });

  it('solves each material independently, so one material cannot starve another', () => {
    const result = packGuillotine(
      [
        part('ply-part', { materialId: 'ply18', qty: 2 }),
        part('mdf-part', { materialId: 'mdf12', qty: 2 }),
      ],
      [stock('ply', { materialId: 'ply18' }), stock('mdf', { materialId: 'mdf12' })],
      CONFIG,
    );
    expect(result.unplacedParts).toEqual([]);
    expect(result.layouts.map((l) => l.stockInstanceId).sort()).toEqual(['mdf#0', 'ply#0']);
  });

  describe('input validation', () => {
    it('throws SolverInputError on an error-severity issue', () => {
      expect(() => packGuillotine([part('p')], [stock('s')], { ...CONFIG, kerf: -1 })).toThrow(
        SolverInputError,
      );
    });

    it('carries the issues on the error, so a caller can show them', () => {
      try {
        packGuillotine([part('p')], [stock('s')], { ...CONFIG, seed: 1.5 });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SolverInputError);
        expect((error as SolverInputError).issues.map((i) => i.kind)).toContain('invalid-seed');
      }
    });

    it('runs anyway on a warning, and says so in unplacedParts', () => {
      // A part too large for any sheet is a warning, not an error: the solver
      // has a perfectly good answer, and refusing to give it would be worse.
      const result = packGuillotine([part('huge', { width: 9999 })], [stock('s')], CONFIG);
      expect(result.unplacedParts).toEqual([{ partId: 'huge', qty: 1 }]);
    });
  });
});
