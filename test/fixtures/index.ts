/**
 * Typed loader for the benchmark fixtures.
 *
 * The fixtures are the ground truth for every claim M1 makes about solver
 * quality, so a malformed one has to fail loudly at load time rather than
 * quietly become a mystery packing bug three PRs later. Everything here throws
 * on bad data, naming the file and the field.
 *
 * That is the opposite of the policy in `src/domain/validate.ts`, deliberately:
 * that module guards data a user typed and owes them a message they can act on,
 * while this one guards data we wrote ourselves and a stack trace is the most
 * useful thing it can produce.
 *
 * Fixtures are JSON rather than TypeScript modules, and are parsed as
 * `unknown` rather than imported through `resolveJsonModule` so the
 * validation below is real rather than TypeScript inferring a shape nobody
 * checked. They are solver-benchmark-only: `bookshelf.json` and
 * `BOOKSHELF_PRESET` (`src/ui/state/presets.ts`) have since diverged in ids,
 * quantities, and unit conventions (fixtures are metric-native for
 * `test/bench`; presets are entered against the UI's imperial-fraction
 * defaults), so `presets.ts` is the example/starter content M6's project
 * templates use, not this directory - see `docs/plan-m6.md` §2.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Material, Part, SolverConfig, Stock, UnplacedPart } from '../../src/domain/types';

/**
 * What a fixture is for.
 *
 * `benchmark` fixtures may be tuned against. `held-out` fixtures run in the
 * bench and must clear the same waste bar, but no heuristic or constant may be
 * chosen by looking at them - that is the only guard against tuning the solver
 * until the benchmark passes rather than until the solver is good.
 * `correctness` fixtures are deliberately unsatisfiable and are excluded from
 * the waste benchmark, because waste is meaningless when parts go unplaced.
 */
export type FixtureRole = 'benchmark' | 'held-out' | 'correctness';

interface FixtureBase {
  name: string;
  /** Prose, including the imperial source dimensions and the hand-checked layout. */
  description: string;
  /**
   * Not consumed by `Solver`, which is given only parts, stock and config.
   * Carried so a fixture is a whole project - it lets the loader check every
   * `materialId` resolves, and lets M6 load one as an example.
   */
  materials: Material[];
  parts: Part[];
  stock: Stock[];
  config: SolverConfig;
}

export type Fixture = FixtureBase &
  ({ role: 'benchmark' | 'held-out' } | { role: 'correctness'; expectedUnplaced: UnplacedPart[] });

const FIXTURE_DIR = fileURLToPath(new URL('.', import.meta.url));

// --- Shape checking ------------------------------------------------------

/** Where in the fixture we are, for the message. Built up as we descend. */
type Path = string;

function fail(file: string, path: Path, detail: string): never {
  throw new Error(`fixture ${file}: ${path} ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(file: string, path: Path, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail(file, path, `must be an object, got ${JSON.stringify(value)}`);
  return value;
}

function requireArray(file: string, path: Path, value: unknown): unknown[] {
  if (!Array.isArray(value)) fail(file, path, `must be an array, got ${JSON.stringify(value)}`);
  return value;
}

function requireString(file: string, path: Path, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(file, path, `must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireBoolean(file: string, path: Path, value: unknown): boolean {
  if (typeof value !== 'boolean')
    fail(file, path, `must be a boolean, got ${JSON.stringify(value)}`);
  return value;
}

/** Millimetres. Zero is rejected here even though `kerf: 0` is legal - see `requireLength`. */
function requirePositiveNumber(file: string, path: Path, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(file, path, `must be a positive finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A length that may legitimately be zero, such as `kerf` or `edgeTrim`. */
function requireLength(file: string, path: Path, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(file, path, `must be a finite number of zero or more, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireCount(file: string, path: Path, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(file, path, `must be a whole number of 1 or more, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

function requireEnum<T extends string>(
  file: string,
  path: Path,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(file, path, `must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function parseMaterial(file: string, path: Path, value: unknown): Material {
  const raw = requireRecord(file, path, value);
  return {
    id: requireString(file, `${path}.id`, raw.id),
    name: requireString(file, `${path}.name`, raw.name),
    thickness: requirePositiveNumber(file, `${path}.thickness`, raw.thickness),
    hasGrain: requireBoolean(file, `${path}.hasGrain`, raw.hasGrain),
  };
}

function parsePart(file: string, path: Path, value: unknown): Part {
  const raw = requireRecord(file, path, value);
  return {
    id: requireString(file, `${path}.id`, raw.id),
    label: requireString(file, `${path}.label`, raw.label),
    width: requirePositiveNumber(file, `${path}.width`, raw.width),
    height: requirePositiveNumber(file, `${path}.height`, raw.height),
    qty: requireCount(file, `${path}.qty`, raw.qty),
    materialId: requireString(file, `${path}.materialId`, raw.materialId),
    rotationPolicy: requireEnum(file, `${path}.rotationPolicy`, raw.rotationPolicy, [
      'locked',
      'free90',
    ] as const),
  };
}

function parseStock(file: string, path: Path, value: unknown): Stock {
  const raw = requireRecord(file, path, value);
  return {
    id: requireString(file, `${path}.id`, raw.id),
    materialId: requireString(file, `${path}.materialId`, raw.materialId),
    width: requirePositiveNumber(file, `${path}.width`, raw.width),
    height: requirePositiveNumber(file, `${path}.height`, raw.height),
    qty: requireCount(file, `${path}.qty`, raw.qty),
    grainAxis: requireEnum(file, `${path}.grainAxis`, raw.grainAxis, ['x', 'y'] as const),
  };
}

function parseConfig(file: string, path: Path, value: unknown): SolverConfig {
  const raw = requireRecord(file, path, value);
  const seed = raw.seed;
  if (!Number.isSafeInteger(seed)) {
    fail(file, `${path}.seed`, `must be a whole number, got ${JSON.stringify(seed)}`);
  }
  return {
    kerf: requireLength(file, `${path}.kerf`, raw.kerf),
    edgeTrim: requireLength(file, `${path}.edgeTrim`, raw.edgeTrim),
    seed: seed as number,
  };
}

// --- Cross-checks --------------------------------------------------------

/**
 * The checks a shape check cannot make.
 *
 * These are the mistakes that are only possible in a fixture: a materialId that
 * does not resolve reads as a plain "no stock for this material" warning at
 * solve time and looks like a deliberate test of that path, so it has to be
 * caught here instead.
 */
function crossCheck(file: string, fixture: Fixture): void {
  const expectedName = file.replace(/\.json$/, '');
  if (fixture.name !== expectedName) {
    fail(file, 'name', `must match the filename, expected "${expectedName}"`);
  }

  const materialIds = new Set<string>();
  for (const material of fixture.materials) {
    if (materialIds.has(material.id))
      fail(file, 'materials', `has a duplicate id "${material.id}"`);
    materialIds.add(material.id);
  }

  const partsById = new Map<string, Part>();
  for (const part of fixture.parts) {
    if (partsById.has(part.id)) fail(file, 'parts', `has a duplicate id "${part.id}"`);
    partsById.set(part.id, part);

    const material = fixture.materials.find((m) => m.id === part.materialId);
    if (material === undefined) {
      fail(file, `part "${part.id}"`, `names material "${part.materialId}", which is not declared`);
    }
    // Grain lock is a statement about visible wood fibre. Locking a part on a
    // grainless material such as MDF or melamine is a fixture-authoring slip
    // that would silently make the packing problem harder than it should be.
    if (part.rotationPolicy === 'locked' && !material.hasGrain) {
      fail(
        file,
        `part "${part.id}"`,
        `is grain-locked but its material "${material.id}" has no grain`,
      );
    }
  }

  const stockIds = new Set<string>();
  for (const sheet of fixture.stock) {
    if (stockIds.has(sheet.id)) fail(file, 'stock', `has a duplicate id "${sheet.id}"`);
    stockIds.add(sheet.id);
    if (!materialIds.has(sheet.materialId)) {
      fail(
        file,
        `stock "${sheet.id}"`,
        `names material "${sheet.materialId}", which is not declared`,
      );
    }
  }

  if (fixture.role === 'correctness') {
    if (fixture.expectedUnplaced.length === 0) {
      fail(file, 'expectedUnplaced', 'must not be empty on a correctness fixture');
    }
    for (const entry of fixture.expectedUnplaced) {
      const part = partsById.get(entry.partId);
      if (part === undefined) {
        fail(file, 'expectedUnplaced', `names part "${entry.partId}", which is not declared`);
      }
      if (entry.qty > part.qty) {
        fail(
          file,
          'expectedUnplaced',
          `expects ${entry.qty} of part "${entry.partId}" unplaced, but only ${part.qty} were requested`,
        );
      }
    }
  }
}

// --- Loading -------------------------------------------------------------

function parseFixture(file: string, source: string): Fixture {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    throw new Error(`fixture ${file}: is not valid JSON`, { cause });
  }

  const record = requireRecord(file, 'the fixture', raw);
  const base: FixtureBase = {
    name: requireString(file, 'name', record.name),
    description: requireString(file, 'description', record.description),
    materials: requireArray(file, 'materials', record.materials).map((m, i) =>
      parseMaterial(file, `materials[${i}]`, m),
    ),
    parts: requireArray(file, 'parts', record.parts).map((p, i) =>
      parsePart(file, `parts[${i}]`, p),
    ),
    stock: requireArray(file, 'stock', record.stock).map((s, i) =>
      parseStock(file, `stock[${i}]`, s),
    ),
    config: parseConfig(file, 'config', record.config),
  };
  if (base.parts.length === 0) fail(file, 'parts', 'must not be empty');
  if (base.stock.length === 0) fail(file, 'stock', 'must not be empty');

  const role = requireEnum(file, 'role', record.role, [
    'benchmark',
    'held-out',
    'correctness',
  ] as const);

  let fixture: Fixture;
  if (role === 'correctness') {
    const expectedUnplaced = requireArray(file, 'expectedUnplaced', record.expectedUnplaced).map(
      (entry, i) => {
        const path = `expectedUnplaced[${i}]`;
        const item = requireRecord(file, path, entry);
        return {
          partId: requireString(file, `${path}.partId`, item.partId),
          qty: requireCount(file, `${path}.qty`, item.qty),
        };
      },
    );
    fixture = { ...base, role, expectedUnplaced };
  } else {
    if (record.expectedUnplaced !== undefined) {
      fail(
        file,
        'expectedUnplaced',
        `is only meaningful on a correctness fixture, not a ${role} one`,
      );
    }
    fixture = { ...base, role };
  }

  crossCheck(file, fixture);
  return fixture;
}

/**
 * Every fixture, ordered by filename.
 *
 * The order is stable so the bench harness reports rows in the same sequence on
 * every run, which is what makes its output diffable against a baseline.
 */
export function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`no fixtures found in ${FIXTURE_DIR}`);
  return files.map((file) => parseFixture(file, readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')));
}

export function loadFixture(name: string): Fixture {
  const fixture = loadFixtures().find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`no fixture named "${name}"`);
  return fixture;
}

/** Fixtures the waste benchmark measures - everything except the unsatisfiable ones. */
export function benchmarkFixtures(): Fixture[] {
  return loadFixtures().filter((fixture) => fixture.role !== 'correctness');
}

/** Exposed for the loader's own tests, which need to feed it deliberately bad data. */
export const parseFixtureForTest = parseFixture;
