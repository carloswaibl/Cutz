import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkResult } from '../../src/domain/validate';
import { solve } from '../../src/solver';
import { benchmarkFixtures, type Fixture } from '../fixtures/index';

interface BaselineEntry {
  sheetsUsed: number;
  wastePct: number;
  unplacedCount: number;
}

type BaselineData = Record<string, BaselineEntry>;

const BASELINE_PATH = fileURLToPath(new URL('./baseline.json', import.meta.url));
const SHOULD_UPDATE_BASELINE =
  process.env.UPDATE_BENCH_BASELINE === 'true' || process.env.UPDATE_BENCH_BASELINE === '1';

const FIXTURES = benchmarkFixtures();

interface BenchRow {
  Fixture: string;
  Role: string;
  Sheets: number;
  'Waste %': string;
  Unplaced: number;
  'Time (ms)': string;
}

describe('solver benchmark harness', () => {
  let baseline: BaselineData = {};
  const newBaseline: BaselineData = {};
  const tableRows: BenchRow[] = [];

  if (existsSync(BASELINE_PATH)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    } catch {
      baseline = {};
    }
  }

  describe.each(FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    'benchmarking %s',
    (_name, fixture: Fixture) => {
      it('solves within baseline constraints and satisfies invariants', () => {
        const start = performance.now();
        const result = solve(fixture.parts, fixture.stock, fixture.config);
        const elapsed = performance.now() - start;

        // Invariant check
        const outcome = checkResult(result, {
          parts: fixture.parts,
          stock: fixture.stock,
          config: fixture.config,
        });

        expect(outcome.violations).toEqual([]);
        expect(outcome.unverifiedSheets).toEqual([]);
        expect(outcome.status).toBe('valid');

        const sheetsUsed = result.layouts.length;
        const wastePct = result.totalWastePct;
        const unplacedCount = result.unplacedParts.reduce((sum, p) => sum + p.qty, 0);

        tableRows.push({
          Fixture: fixture.name,
          Role: fixture.role,
          Sheets: sheetsUsed,
          'Waste %': `${(wastePct * 100).toFixed(2)}%`,
          Unplaced: unplacedCount,
          'Time (ms)': elapsed.toFixed(2),
        });

        newBaseline[fixture.name] = {
          sheetsUsed,
          wastePct,
          unplacedCount,
        };

        if (!SHOULD_UPDATE_BASELINE) {
          const expected = baseline[fixture.name];
          if (!expected) {
            throw new Error(
              `No baseline entry found for fixture "${fixture.name}". Run "npm run bench:update" to generate baseline.json.`,
            );
          }

          expect(
            unplacedCount,
            `${fixture.name} unplaced count regressed: ${unplacedCount} > ${expected.unplacedCount}`,
          ).toBeLessThanOrEqual(expected.unplacedCount);

          expect(
            sheetsUsed,
            `${fixture.name} sheet count regressed: ${sheetsUsed} > ${expected.sheetsUsed}`,
          ).toBeLessThanOrEqual(expected.sheetsUsed);

          // Epsilon tolerance for floating point accuracy (1e-6)
          expect(
            wastePct,
            `${fixture.name} waste percentage regressed: ${(wastePct * 100).toFixed(2)}% > ${(expected.wastePct * 100).toFixed(2)}%`,
          ).toBeLessThanOrEqual(expected.wastePct + 1e-6);
        }
      });
    },
  );

  afterAll(() => {
    if (tableRows.length > 0) {
      console.log('\n--- Solver Benchmark Results ---');
      console.table(tableRows);
    }

    if (SHOULD_UPDATE_BASELINE) {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(newBaseline, null, 2)}\n`, 'utf8');
      console.log(`Updated benchmark baseline at ${BASELINE_PATH}`);
    }
  });
});
