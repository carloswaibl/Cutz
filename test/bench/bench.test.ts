import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { SolverConfig } from '../../src/domain/types';
import { checkResult, solverMode } from '../../src/domain/validate';
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

/**
 * Per-test budget, well above what any fixture takes.
 *
 * Vitest defaults to five seconds, which is a unit test's budget and not a
 * benchmark's: a nest fixture rasterises every orientation of every part and
 * scans a bitmap of a whole sheet, a dozen times over. This is a guard against
 * a hang, not a performance assertion - the real timings are printed in the
 * comparison table below, where a regression is legible rather than a red test
 * with no number in it.
 */
const BENCH_TIMEOUT_MS = 120_000;

interface BenchRow {
  Fixture: string;
  Role: string;
  Sheets: number;
  'Waste %': string;
  Unplaced: number;
  'Time (ms)': string;
}

/**
 * What a nest fixture costs on a table saw instead, for comparison.
 *
 * **Sheets is the honest comparison, not waste.** The two modes measure
 * consumed area differently on purpose - a saw loses a part's whole bounding
 * box, a router only its outline (`docs/plan-m7.md` §7 decision 4) - so their
 * waste percentages are answers to different questions and subtracting one from
 * the other means nothing. Sheets used is the same question either way, and it
 * is the one a woodworker is actually buying.
 */
interface NestComparison {
  fixture: string;
  nestSheets: number;
  sawSheets: number;
  nestWastePct: number;
  sawWastePct: number;
  nestMs: number;
}

describe('solver benchmark harness', () => {
  let baseline: BaselineData = {};
  const newBaseline: BaselineData = {};
  const tableRows: BenchRow[] = [];
  const comparisons: NestComparison[] = [];

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
      it(
        'solves within baseline constraints and satisfies invariants',
        () => {
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
        },
        BENCH_TIMEOUT_MS,
      );

      // Only a nest fixture has a second engine worth comparing against. A
      // guillotine fixture solved with the nester would be measuring the wrong
      // thing entirely: those fixtures are hand-designed to tile a sheet with
      // rectangles, which is what a saw is *for*.
      if (solverMode(fixture.config) !== 'nest') return;

      it(
        'beats the table saw it is being nested instead of',
        () => {
          const sawConfig: SolverConfig = { ...fixture.config, mode: 'guillotine' };

          const start = performance.now();
          const nested = solve(fixture.parts, fixture.stock, fixture.config);
          const nestMs = performance.now() - start;
          const sawn = solve(fixture.parts, fixture.stock, sawConfig);

          // The saw layout has to be a legal saw layout, checked as one. Without
          // this the comparison could be against something uncuttable, which
          // would flatter the nester for free.
          expect(
            checkResult(sawn, { parts: fixture.parts, stock: fixture.stock, config: sawConfig })
              .violations,
          ).toEqual([]);

          comparisons.push({
            fixture: fixture.name,
            nestSheets: nested.layouts.length,
            sawSheets: sawn.layouts.length,
            nestWastePct: nested.totalWastePct,
            sawWastePct: sawn.totalWastePct,
            nestMs,
          });

          // `docs/plan-m7.md` §1 criterion 6, as an assertion rather than a
          // report: a nester that does not beat a bounding-box packer on
          // irregular parts has not earned its place in the codebase.
          expect(
            nested.layouts.length,
            `${fixture.name}: nesting used ${nested.layouts.length} sheets, the saw used ${sawn.layouts.length}`,
          ).toBeLessThan(sawn.layouts.length);

          // Fewer sheets is only a win if everything still got made.
          expect(nested.unplacedParts).toEqual([]);
        },
        BENCH_TIMEOUT_MS,
      );
    },
  );

  afterAll(() => {
    if (tableRows.length > 0) {
      console.log('\n--- Solver Benchmark Results ---');
      console.table(tableRows);
    }

    if (comparisons.length > 0) {
      console.log('\n--- CNC nesting vs table saw, same parts and stock ---');
      console.log(
        'Sheets is the comparable number. The two waste figures answer different\n' +
          "questions - a saw consumes a part's bounding box, a router its outline -\n" +
          'so they are reported side by side and never subtracted.',
      );
      console.table(
        comparisons.map((c) => ({
          Fixture: c.fixture,
          'Nest sheets': c.nestSheets,
          'Saw sheets': c.sawSheets,
          'Sheets saved': c.sawSheets - c.nestSheets,
          'Nest waste % (of outline)': `${(c.nestWastePct * 100).toFixed(2)}%`,
          'Saw waste % (of box)': `${(c.sawWastePct * 100).toFixed(2)}%`,
          'Nest time (ms)': c.nestMs.toFixed(0),
        })),
      );
    }

    if (SHOULD_UPDATE_BASELINE) {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(newBaseline, null, 2)}\n`, 'utf8');
      console.log(`Updated benchmark baseline at ${BASELINE_PATH}`);
    }
  });
});
