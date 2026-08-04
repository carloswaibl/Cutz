import { describe, expect, it } from 'vitest';
import { inchToMm } from '../../src/domain/units';
import { hasErrors, validateInputs } from '../../src/domain/validate';
import {
  benchmarkFixtures,
  type Fixture,
  loadFixture,
  loadFixtures,
  parseFixtureForTest,
} from './index';

const FIXTURES = loadFixtures();

/**
 * A fixture that is valid, so each test below can corrupt one field and check
 * that the loader notices. Built inline rather than loaded, so a change to a
 * real fixture cannot quietly turn these into no-ops.
 */
const VALID = JSON.stringify({
  name: 'sample',
  description: 'A minimal well-formed fixture.',
  role: 'benchmark',
  materials: [{ id: 'ply18', name: '18mm ply', thickness: 18, hasGrain: true }],
  parts: [
    {
      id: 'shelf',
      label: 'Shelf',
      width: 780,
      height: 300,
      qty: 4,
      materialId: 'ply18',
      rotationPolicy: 'locked',
    },
  ],
  stock: [{ id: 'sheet', materialId: 'ply18', width: 2440, height: 1220, qty: 1, grainAxis: 'x' }],
  config: { kerf: 3, edgeTrim: 5, seed: 1 },
});

/** The first entry of one of the sample's lists, for tests that corrupt a field. */
function first(list: unknown): Record<string, unknown> {
  const entry = (list as Record<string, unknown>[])[0];
  if (entry === undefined) throw new Error('the sample fixture should not have an empty list');
  return entry;
}

function withSample(mutate: (fixture: Record<string, unknown>) => void): () => void {
  return () => {
    const raw = JSON.parse(VALID) as Record<string, unknown>;
    mutate(raw);
    parseFixtureForTest('sample.json', JSON.stringify(raw));
  };
}

describe('the fixture set', () => {
  it('has every fixture named in the M1 plan', () => {
    expect(FIXTURES.map((fixture) => fixture.name)).toEqual([
      'bookshelf',
      'cabinet-carcass',
      'closet-organizer',
      'drawer-boxes',
      'grain-locked-panels',
      'insufficient-stock',
      'mixed-stock',
      'oversized-part',
      'tight-fit',
      'workbench-cabinet',
    ]);
  });

  it('holds out exactly the two fixtures no heuristic may be tuned against', () => {
    const heldOut = FIXTURES.filter((fixture) => fixture.role === 'held-out');
    expect(heldOut.map((fixture) => fixture.name)).toEqual(['grain-locked-panels', 'mixed-stock']);
  });

  it('excludes only the unsatisfiable fixtures from the waste benchmark', () => {
    const excluded = FIXTURES.filter((fixture) => fixture.role === 'correctness');
    expect(excluded.map((fixture) => fixture.name)).toEqual([
      'insufficient-stock',
      'oversized-part',
    ]);
    expect(benchmarkFixtures()).toHaveLength(FIXTURES.length - excluded.length);
  });

  it('loads a fixture by name and rejects an unknown one', () => {
    expect(loadFixture('bookshelf').name).toBe('bookshelf');
    expect(() => loadFixture('no-such-fixture')).toThrow(/no fixture named/);
  });

  it('records the hand-checked layout in every description', () => {
    // The description is the only record of why a fixture's dimensions are what
    // they are. Without it the numbers look arbitrary and get "tidied".
    for (const fixture of FIXTURES) {
      expect(fixture.description.length).toBeGreaterThan(120);
    }
  });

  it('covers more than one material somewhere in the set', () => {
    // Parts are grouped into fully independent subproblems by material, and
    // nothing exercises that split unless a fixture actually has two.
    const multiMaterial = FIXTURES.filter((fixture) => fixture.materials.length > 1);
    expect(multiMaterial.map((fixture) => fixture.name)).toEqual([
      'drawer-boxes',
      'workbench-cabinet',
    ]);
  });
});

describe('fixture inputs', () => {
  /**
   * The first time PR 2's validator meets realistic data. A benchmark fixture
   * that trips any issue at all is malformed: the solver is supposed to be able
   * to place every part, and an issue here would mean the fixture, not the
   * solver, decided the outcome.
   */
  it.each(
    FIXTURES.filter((fixture) => fixture.role !== 'correctness').map((f): [string, Fixture] => [
      f.name,
      f,
    ]),
  )('reports no input issues for %s', (_name, fixture) => {
    expect(validateInputs(fixture.parts, fixture.stock, fixture.config)).toEqual([]);
  });

  it('warns that the oversized part cannot be placed, before the solver runs', () => {
    const fixture = loadFixture('oversized-part');
    const issues = validateInputs(fixture.parts, fixture.stock, fixture.config);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'part-too-large',
      partId: 'worktop',
      severity: 'warning',
    });
    // A warning, not an error: the solver runs fine and says so in unplacedParts.
    expect(hasErrors(issues)).toBe(false);
  });

  it('reports nothing for insufficient-stock, because a shortfall is not an input problem', () => {
    const fixture = loadFixture('insufficient-stock');
    // Every part fits a sheet; there are simply not enough sheets. That is the
    // solver's answer to give, not the validator's.
    expect(validateInputs(fixture.parts, fixture.stock, fixture.config)).toEqual([]);
  });

  it('declares a shortfall no larger than the quantity requested', () => {
    for (const fixture of FIXTURES) {
      if (fixture.role !== 'correctness') continue;
      for (const entry of fixture.expectedUnplaced) {
        const part = fixture.parts.find((candidate) => candidate.id === entry.partId);
        expect(part?.qty).toBeGreaterThanOrEqual(entry.qty);
      }
    }
  });
});

describe('tight-fit', () => {
  const fixture = loadFixture('tight-fit');
  const sheet = fixture.stock[0];

  it('keeps the exact doubles a 4x8 sheet converts to', () => {
    // Not 1219.2 and 2438.4. The whole point of this fixture is that the sheet
    // is a hair narrower than the parts that have to tile it, which is what
    // every tolerant comparison in geometry.ts exists to survive. Rounding
    // these literals to something tidy would silently retire the test.
    expect(sheet?.width).toBe(inchToMm(48));
    expect(sheet?.height).toBe(inchToMm(96));
    expect(sheet?.width).toBeLessThan(1219.2);
    expect(sheet?.height).toBeLessThan(2438.4);
  });

  it('uses a 1/8 inch kerf', () => {
    expect(fixture.config.kerf).toBe(inchToMm(0.125));
  });

  it('has parts that tile the sheet exactly, to the last kerf', () => {
    const part = fixture.parts[0];
    expect(part).toBeDefined();
    if (part === undefined || sheet === undefined) return;

    const kerf = fixture.config.kerf;
    // Two columns and four rows, with kerf between neighbours and none at the
    // sheet edges - no cut happens there, so no material is lost there.
    expect(2 * part.width + kerf).toBeCloseTo(sheet.width, 9);
    expect(4 * part.height + 3 * kerf).toBeCloseTo(sheet.height, 9);
    expect(part.qty).toBe(8);

    // And the tiling only just does not fit in exact arithmetic, which is the
    // condition the tolerant comparisons have to absorb.
    expect(2 * part.width + kerf).toBeGreaterThan(sheet.width);
  });

  it('has no edge trim, so the tiling covers the whole sheet', () => {
    expect(fixture.config.edgeTrim).toBe(0);
  });
});

describe('the loader', () => {
  it('accepts a well-formed fixture', () => {
    expect(() => parseFixtureForTest('sample.json', VALID)).not.toThrow();
  });

  it('rejects malformed JSON', () => {
    expect(() => parseFixtureForTest('sample.json', '{ not json')).toThrow(/not valid JSON/);
  });

  it('names the file and the field it rejected', () => {
    // The message is the entire value of this loader over `resolveJsonModule`.
    expect(
      withSample((f) => {
        first(f.parts).width = -5;
      }),
    ).toThrow(/sample\.json: parts\[0\]\.width/);
  });

  it('rejects a name that does not match the filename', () => {
    expect(
      withSample((f) => {
        f.name = 'something-else';
      }),
    ).toThrow(/must match the filename/);
  });

  it('rejects a part whose material is not declared', () => {
    expect(
      withSample((f) => {
        first(f.parts).materialId = 'mystery';
      }),
    ).toThrow(/names material "mystery"/);
  });

  it('rejects stock whose material is not declared', () => {
    expect(
      withSample((f) => {
        first(f.stock).materialId = 'mystery';
      }),
    ).toThrow(/names material "mystery"/);
  });

  it('rejects a grain-locked part on a material with no grain', () => {
    // Locking a part on MDF or melamine makes the packing problem harder for a
    // reason that does not exist in the workshop.
    expect(
      withSample((f) => {
        first(f.materials).hasGrain = false;
      }),
    ).toThrow(/grain-locked but its material/);
  });

  it('rejects duplicate ids', () => {
    expect(
      withSample((f) => {
        const parts = f.parts as Record<string, unknown>[];
        parts.push({ ...parts[0] });
      }),
    ).toThrow(/duplicate id "shelf"/);

    expect(
      withSample((f) => {
        const stock = f.stock as Record<string, unknown>[];
        stock.push({ ...stock[0] });
      }),
    ).toThrow(/duplicate id "sheet"/);
  });

  it('rejects an unknown role', () => {
    expect(
      withSample((f) => {
        f.role = 'smoke-test';
      }),
    ).toThrow(/role must be one of/);
  });

  it('requires expectedUnplaced on a correctness fixture and forbids it elsewhere', () => {
    expect(
      withSample((f) => {
        f.role = 'correctness';
      }),
    ).toThrow(/expectedUnplaced must be an array/);

    expect(
      withSample((f) => {
        f.role = 'correctness';
        f.expectedUnplaced = [];
      }),
    ).toThrow(/must not be empty/);

    expect(
      withSample((f) => {
        f.expectedUnplaced = [{ partId: 'shelf', qty: 1 }];
      }),
    ).toThrow(/only meaningful on a correctness fixture/);
  });

  it('rejects a shortfall larger than the quantity requested', () => {
    // Otherwise the fixture asserts something arithmetically impossible and the
    // solver gets blamed for it.
    expect(
      withSample((f) => {
        f.role = 'correctness';
        f.expectedUnplaced = [{ partId: 'shelf', qty: 99 }];
      }),
    ).toThrow(/only 4 were requested/);
  });

  it('rejects a shortfall for a part that is not declared', () => {
    expect(
      withSample((f) => {
        f.role = 'correctness';
        f.expectedUnplaced = [{ partId: 'ghost', qty: 1 }];
      }),
    ).toThrow(/names part "ghost"/);
  });

  it('rejects empty part and stock lists', () => {
    expect(
      withSample((f) => {
        f.parts = [];
      }),
    ).toThrow(/parts must not be empty/);

    expect(
      withSample((f) => {
        f.stock = [];
      }),
    ).toThrow(/stock must not be empty/);
  });

  it('rejects a non-integer quantity', () => {
    expect(
      withSample((f) => {
        first(f.parts).qty = 2.5;
      }),
    ).toThrow(/must be a whole number of 1 or more/);
  });

  it('rejects a seed that is not a whole number', () => {
    // A fractional seed makes the PRNG's stream depend on float rounding, which
    // costs the reproducibility the seed exists to provide.
    expect(
      withSample((f) => {
        (f.config as Record<string, unknown>).seed = 1.5;
      }),
    ).toThrow(/config\.seed must be a whole number/);
  });

  it('accepts a kerf or edge trim of zero but not a negative one', () => {
    expect(
      withSample((f) => {
        (f.config as Record<string, unknown>).kerf = 0;
        (f.config as Record<string, unknown>).edgeTrim = 0;
      }),
    ).not.toThrow();

    expect(
      withSample((f) => {
        (f.config as Record<string, unknown>).kerf = -1;
      }),
    ).toThrow(/config\.kerf must be a finite number of zero or more/);
  });

  it('rejects a missing field rather than defaulting it', () => {
    expect(
      withSample((f) => {
        delete f.description;
      }),
    ).toThrow(/description must be a non-empty string/);

    expect(
      withSample((f) => {
        delete f.config;
      }),
    ).toThrow(/config must be an object/);
  });
});
