/**
 * DXF export tests.
 *
 * The thing that matters here is that the geometry survives the trip. A DXF has
 * no physical size of its own - just bare numbers and a `$INSUNITS` declaration
 * saying what they mean - so a scale error or an axis flip produces a drawing
 * that looks entirely correct and cuts wrong. Both are checked by parsing the
 * emitted file back into rectangles and comparing them to the placements they
 * came from, on every fixture.
 *
 * The golden file under `golden/` is a real DXF. Open it.
 */

import { describe, expect, it } from 'vitest';
import { buildCutPlan, type CutPlan } from '../../src/domain/cutplan';
import { type Rect, usableArea } from '../../src/domain/geometry';
import { parseStockInstanceId } from '../../src/domain/instances';
import { placementPolygon, placementRect } from '../../src/domain/polygon';
import type { Layout, Material, Part, SolverConfig, Stock } from '../../src/domain/types';
import { DXF_LAYERS, renderSheetDxf, sheetToDxf } from '../../src/export/dxf';
import { solve } from '../../src/solver';
import type { DisplayUnit } from '../../src/ui/state/types';
import { type Fixture, loadFixture, loadFixtures } from '../fixtures/index';

const GENERATED_AT = new Date('2026-01-15T09:30:00.000Z');

// ---------------------------------------------------------------------------
// A minimal DXF reader
// ---------------------------------------------------------------------------

interface Pair {
  code: number;
  value: string;
}

interface DxfEntity {
  type: string;
  layer: string;
  /** Vertices for a POLYLINE, both endpoints for a LINE, the insertion for TEXT. */
  points: { x: number; y: number }[];
  text?: string;
  height?: number;
  /** POLYLINE only: group 70 bit 1, the flag that joins the last vertex to the first. */
  closed?: boolean;
  /** POLYLINE only: group 66, "vertices follow". */
  verticesFollow?: boolean;
}

interface ParsedDxf {
  header: Map<string, Pair[]>;
  layers: string[];
  entities: DxfEntity[];
}

function toPairs(dxf: string): Pair[] {
  const lines = dxf.split('\n');
  // The file ends with a terminating newline, so the final split element is
  // empty and is not half a pair.
  expect(lines.at(-1)).toBe('');
  lines.pop();
  expect(lines.length % 2).toBe(0);

  const pairs: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number((lines[i] ?? '').trim());
    expect(Number.isInteger(code)).toBe(true);
    pairs.push({ code, value: (lines[i + 1] ?? '').trim() });
  }
  return pairs;
}

/**
 * Read the file the way a DXF reader does: a flat stream of code/value pairs,
 * grouped by the `0` records that start each entity.
 *
 * Deliberately not a general parser - it understands exactly the subset this
 * exporter writes, so a change that emits something new has to be taught to the
 * reader rather than passing unexamined.
 */
function parseDxf(dxf: string): ParsedDxf {
  const pairs = toPairs(dxf);
  const header = new Map<string, Pair[]>();
  const layers: string[] = [];
  const entities: DxfEntity[] = [];

  let section: string | null = null;
  let table: string | null = null;
  let headerVar: string | null = null;

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;

    if (pair.code === 0 && pair.value === 'SECTION') {
      section = pairs[i + 1]?.value ?? null;
      continue;
    }
    if (pair.code === 0 && pair.value === 'ENDSEC') {
      section = null;
      continue;
    }

    if (section === 'HEADER') {
      if (pair.code === 9) {
        headerVar = pair.value;
        header.set(headerVar, []);
      } else if (headerVar) {
        header.get(headerVar)?.push(pair);
      }
      continue;
    }

    if (section === 'TABLES') {
      if (pair.code === 0 && pair.value === 'TABLE') {
        table = pairs[i + 1]?.value ?? null;
      } else if (pair.code === 0 && pair.value === 'ENDTAB') {
        table = null;
      } else if (table === 'LAYER' && pair.code === 0 && pair.value === 'LAYER') {
        const name = pairs[i + 1];
        if (name?.code === 2) layers.push(name.value);
      }
      continue;
    }

    if (section !== 'ENTITIES' || pair.code !== 0) continue;

    if (pair.value === 'VERTEX') {
      // Vertices belong to the polyline that opened before them.
      const owner = entities.at(-1);
      expect(owner?.type).toBe('POLYLINE');
      owner?.points.push(readPoint(pairs, i, 10));
      continue;
    }
    if (pair.value === 'SEQEND' || pair.value === 'EOF') continue;

    const entity: DxfEntity = {
      type: pair.value,
      layer: readString(pairs, i, 8) ?? '',
      // A POLYLINE header carries a dummy point that 2D readers ignore; its real
      // geometry is in the VERTEX records that follow.
      points: pair.value === 'POLYLINE' ? [] : [readPoint(pairs, i, 10)],
    };
    if (pair.value === 'POLYLINE') {
      entity.closed = (readNumber(pairs, i, 70) & 1) === 1;
      entity.verticesFollow = readNumber(pairs, i, 66) === 1;
    }
    if (pair.value === 'LINE') entity.points.push(readPoint(pairs, i, 11));
    if (pair.value === 'TEXT') {
      entity.text = readString(pairs, i, 1) ?? '';
      entity.height = readNumber(pairs, i, 40);
    }
    entities.push(entity);
  }

  return { header, layers, entities };
}

/** Scan forward from an entity's `0` record to the next one, for a group code. */
function readGroup(pairs: Pair[], start: number, code: number): string | undefined {
  for (let i = start + 1; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair || pair.code === 0) return undefined;
    if (pair.code === code) return pair.value;
  }
  return undefined;
}

function readString(pairs: Pair[], start: number, code: number): string | undefined {
  return readGroup(pairs, start, code);
}

function readNumber(pairs: Pair[], start: number, code: number): number {
  return Number(readGroup(pairs, start, code));
}

function readPoint(pairs: Pair[], start: number, code: number): { x: number; y: number } {
  return { x: readNumber(pairs, start, code), y: readNumber(pairs, start, code + 10) };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Sheet {
  layout: Layout;
  stock: Stock;
  material: Material;
  parts: Part[];
  config: SolverConfig;
  sheetNumber: number;
  sheetCount: number;
}

/** Every solved sheet of a fixture, with everything needed to draw one. */
function sheetsOf(fixture: Fixture): Sheet[] {
  const result = solve(fixture.parts, fixture.stock, fixture.config);
  return result.layouts.map((layout, index) => {
    const ref = parseStockInstanceId(layout.stockInstanceId);
    const stock = fixture.stock.find((entry) => entry.id === ref?.stockId);
    if (!stock) throw new Error(`no stock for instance "${layout.stockInstanceId}"`);
    const material = fixture.materials.find((m) => m.id === stock.materialId);
    if (!material) throw new Error(`no material for stock "${stock.id}"`);
    return {
      layout,
      stock,
      material,
      parts: fixture.parts,
      config: fixture.config,
      sheetNumber: index + 1,
      sheetCount: result.layouts.length,
    };
  });
}

/**
 * Solved first sheets, cached by fixture name.
 *
 * A nest fixture takes seconds to solve and several tests want the same one.
 * The solver is deterministic, so reusing the result is exactly what a second
 * solve would have produced.
 */
const firstSheetCache = new Map<string, Sheet>();

function firstSheet(fixtureName: string): Sheet {
  const cached = firstSheetCache.get(fixtureName);
  if (cached) return cached;
  const sheet = sheetsOf(loadFixture(fixtureName))[0];
  if (!sheet) throw new Error(`fixture "${fixtureName}" solved to no layouts`);
  firstSheetCache.set(fixtureName, sheet);
  return sheet;
}

function render(sheet: Sheet, overrides: Partial<Parameters<typeof renderSheetDxf>[0]> = {}) {
  return renderSheetDxf({
    layout: sheet.layout,
    stock: sheet.stock,
    parts: sheet.parts,
    material: sheet.material,
    config: sheet.config,
    displayUnit: 'metric-mm',
    fractionDenominator: 16,
    sheetNumber: sheet.sheetNumber,
    sheetCount: sheet.sheetCount,
    generatedAt: GENERATED_AT,
    ...overrides,
  });
}

function planFor(sheet: Sheet): CutPlan {
  return buildCutPlan({
    stock: sheet.stock,
    material: sheet.material,
    layout: sheet.layout,
    parts: sheet.parts,
    config: sheet.config,
  });
}

function entitiesOn(parsed: ParsedDxf, layer: string, type?: string): DxfEntity[] {
  return parsed.entities.filter(
    (e) => e.layer === layer && (type === undefined || e.type === type),
  );
}

/**
 * Turn a parsed outline back into a sheet-space rectangle.
 *
 * This is the inverse of everything the exporter did - the Y flip and the unit
 * scale both come back out - so a rect that survives it round trip is one a CAD
 * user will measure correctly.
 */
function toSheetRect(entity: DxfEntity, stock: Stock, scale: number): Rect {
  const xs = entity.points.map((p) => p.x / scale);
  const ys = entity.points.map((p) => stock.height - p.y / scale);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Rects in a canonical order, so two sets can be compared without one. */
function sortRects(rects: Rect[]): Rect[] {
  return [...rects].sort((a, b) => a.y - b.y || a.x - b.x || a.width - b.width);
}

function expectRectsClose(actual: Rect[], expected: Rect[]): void {
  expect(actual).toHaveLength(expected.length);
  const a = sortRects(actual);
  const b = sortRects(expected);
  for (let i = 0; i < b.length; i++) {
    const got = a[i];
    const want = b[i];
    expect(got).toBeDefined();
    expect(want).toBeDefined();
    if (!got || !want) continue;
    expect(got.x).toBeCloseTo(want.x, 5);
    expect(got.y).toBeCloseTo(want.y, 5);
    expect(got.width).toBeCloseTo(want.width, 5);
    expect(got.height).toBeCloseTo(want.height, 5);
  }
}

const UNIT_SCALE: Record<DisplayUnit, number> = {
  'imperial-fraction': 1 / 25.4,
  'imperial-decimal': 1 / 25.4,
  'metric-mm': 1,
};

// ---------------------------------------------------------------------------

describe('renderSheetDxf structure', () => {
  it('emits the four R12 sections and nothing that needs handles', () => {
    const dxf = render(firstSheet('bookshelf'));
    expect(dxf).toContain('$ACADVER');
    expect(dxf).toContain('AC1009');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);

    // R13+ constructs. Emitting any of them means the file claims a version it
    // does not structurally satisfy.
    expect(dxf).not.toContain('LWPOLYLINE');
    expect(dxf).not.toContain('CLASSES');
    expect(dxf).not.toContain('OBJECTS');
  });

  it('declares every layer it draws on', () => {
    const parsed = parseDxf(render(firstSheet('bookshelf'), { showCutLines: false }));
    expect(parsed.layers).toEqual(Object.values(DXF_LAYERS));

    // A layer table entry naming a linetype the file never defines is rejected
    // by strict readers.
    for (const entity of parsed.entities) {
      expect(parsed.layers).toContain(entity.layer);
    }
  });

  it('draws the sheet, the trim line, and one outline per part', () => {
    const sheet = firstSheet('bookshelf');
    expect(sheet.config.edgeTrim).toBeGreaterThan(0);
    const parsed = parseDxf(render(sheet));

    expect(entitiesOn(parsed, DXF_LAYERS.sheet, 'POLYLINE')).toHaveLength(1);
    expect(entitiesOn(parsed, DXF_LAYERS.trim, 'POLYLINE')).toHaveLength(1);
    expect(entitiesOn(parsed, DXF_LAYERS.parts, 'POLYLINE')).toHaveLength(
      sheet.layout.placements.length,
    );
    // A label and a dimension line per part.
    expect(entitiesOn(parsed, DXF_LAYERS.labels, 'TEXT')).toHaveLength(
      sheet.layout.placements.length * 2,
    );
  });

  it('omits the trim line when there is no edge trim', () => {
    // Drawing one on the sheet boundary would imply a cut nobody makes.
    const sheet = firstSheet('bookshelf');
    const config = { ...sheet.config, edgeTrim: 0 };
    const parsed = parseDxf(render({ ...sheet, config }, { config }));
    expect(entitiesOn(parsed, DXF_LAYERS.trim)).toHaveLength(0);
  });

  it('closes every outline', () => {
    // Without the closed flag the last edge is missing, and a CAM toolpath
    // built from the outline runs off the end of the part.
    //
    // Four points is asserted for a *sawn* sheet specifically: every outline in
    // one is a rectangle, and a fifth vertex would mean the exporter had started
    // emitting geometry a table saw cannot produce. A nested sheet is checked
    // below, where the vertex count is the shape's and not a constant.
    const parsed = parseDxf(render(firstSheet('bookshelf')));
    const polylines = parsed.entities.filter((e) => e.type === 'POLYLINE');
    expect(polylines.length).toBeGreaterThan(0);
    for (const entity of polylines) {
      expect(entity.points).toHaveLength(4);
      expect(entity.closed).toBe(true);
      expect(entity.verticesFollow).toBe(true);
    }
  });

  it('writes a nested part as its true outline, not its bounding box', () => {
    // The whole point of exporting a nested layout: a router following the
    // POLYLINE has to trace the part, and a four-point box would cut away every
    // other part packed into this one's concavities.
    const sheet = firstSheet('nest-triangles');
    const parsed = parseDxf(render(sheet, { showCutLines: false }));
    const outlines = entitiesOn(parsed, DXF_LAYERS.parts, 'POLYLINE');
    expect(outlines).toHaveLength(sheet.layout.placements.length);

    const partsById = new Map(sheet.parts.map((p) => [p.id, p]));
    const shaped = sheet.layout.placements.filter(
      (p) => partsById.get(p.partId)?.outline !== undefined,
    );
    expect(shaped.length).toBeGreaterThan(0);

    // Vertex counts are the shapes' own, and every outline still closes.
    const expectedCounts = sheet.layout.placements
      .map((p) => placementPolygon(partsById.get(p.partId) as Part, p).length)
      .sort((a, b) => a - b);
    expect(outlines.map((e) => e.points.length).sort((a, b) => a - b)).toEqual(expectedCounts);
    for (const entity of outlines) {
      expect(entity.closed).toBe(true);
      expect(entity.verticesFollow).toBe(true);
    }

    // And the geometry is the real thing, not just the right number of points:
    // every emitted vertex, flipped and unscaled, is a vertex of the polygon the
    // validator certified.
    // `render` defaults to metric-mm, so the scale is 1 and only the Y flip has
    // to be undone.
    const scale = UNIT_SCALE['metric-mm'];
    const expectedVertices = new Set(
      sheet.layout.placements.flatMap((p) =>
        placementPolygon(partsById.get(p.partId) as Part, p).map(
          (pt) => `${pt.x.toFixed(3)},${pt.y.toFixed(3)}`,
        ),
      ),
    );
    for (const entity of outlines) {
      for (const pt of entity.points) {
        const key = `${(pt.x / scale).toFixed(3)},${(sheet.stock.height - pt.y / scale).toFixed(3)}`;
        expect(expectedVertices).toContain(key);
      }
    }
    // Solving a nested fixture takes seconds, and Vitest runs files in parallel
    // against a 5s default - the contention `test/solver/nest/solver.test.ts`
    // documents from M7 PR 7. Same budget as the sweep below.
  }, 120_000);

  it('names the angle a nested part is turned to', () => {
    // '(R)' alone dates from M3, when the only rotation was a quarter turn. On a
    // router it would say a 30° part and a 90° one were the same thing, and the
    // operator checking the sheet against the file has no other way to tell.
    const sheet = firstSheet('nest-triangles');
    const parsed = parseDxf(render(sheet, { showCutLines: false }));
    const turned = sheet.layout.placements.filter((p) => p.angleDeg !== 0 && p.angleDeg !== 90);
    expect(turned.length).toBeGreaterThan(0);

    const labels = entitiesOn(parsed, DXF_LAYERS.labels, 'TEXT').map((e) => e.text ?? '');
    for (const placement of turned) {
      expect(labels).toContain(
        `${sheet.parts.find((p) => p.id === placement.partId)?.label} (R${Math.round(placement.angleDeg)})`,
      );
    }
  }, 120_000);

  it('is deterministic', () => {
    const sheet = firstSheet('cabinet-carcass');
    expect(render(sheet)).toBe(render(sheet));
  });

  it('generates only ASCII text', () => {
    // R12 predates any reliable encoding declaration, so the text this module
    // generates itself - the rotation marker, the dimension separator - stays in
    // ASCII. User-supplied labels pass through as they are given.
    for (const name of ['bookshelf', 'mixed-stock', 'grain-locked-panels']) {
      for (const sheet of sheetsOf(loadFixture(name))) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find bytes outside printable ASCII
        expect(render(sheet)).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
      }
    }
  });

  it('never lets user text break the line structure', () => {
    // A DXF *is* its line structure: a two-line part label would be read as a
    // value followed by a stray group code, corrupting the rest of the file.
    const sheet = firstSheet('bookshelf');
    const first = sheet.parts[0];
    expect(first).toBeDefined();
    if (!first) return;
    const parts = sheet.parts.map((part) =>
      part.id === first.id ? { ...part, label: 'Top\nshelf' } : part,
    );

    const parsed = parseDxf(render(sheet, { parts }));
    expect(parsed.entities.some((e) => e.text === 'Top shelf')).toBe(true);
    expect(entitiesOn(parsed, DXF_LAYERS.labels, 'TEXT')).toHaveLength(
      sheet.layout.placements.length * 2,
    );
  });
});

describe('renderSheetDxf geometry', () => {
  // Every fixture, nest ones included - a turned part's footprint is the bounds
  // of its rotated outline, and a writer that got that wrong would produce a
  // drawing that looks plausible and cuts wrong. Solving three nested sheets is
  // why this one carries a benchmark's time budget.
  it('round-trips every placement on every fixture', () => {
    // The load-bearing test. Parse the part outlines back out, undo the Y flip
    // and the unit scale, and require what comes back to be exactly the rects
    // the solver placed.
    for (const fixture of loadFixtures()) {
      for (const sheet of sheetsOf(fixture)) {
        const parsed = parseDxf(render(sheet));
        const actual = entitiesOn(parsed, DXF_LAYERS.parts, 'POLYLINE').map((entity) =>
          toSheetRect(entity, sheet.stock, 1),
        );
        const expected = sheet.layout.placements.map((placement) => {
          const part = sheet.parts.find((p) => p.id === placement.partId);
          if (!part) throw new Error(`layout names a part the fixture lacks: ${placement.partId}`);
          return placementRect(part, placement);
        });
        expectRectsClose(actual, expected);
      }
    }
  }, 120_000);

  it('round-trips in inches too', () => {
    // The case that catches a 25.4x scale error, which otherwise produces a
    // drawing that looks exactly right.
    const sheet = firstSheet('bookshelf');
    const parsed = parseDxf(render(sheet, { displayUnit: 'imperial-decimal' }));
    const actual = entitiesOn(parsed, DXF_LAYERS.parts, 'POLYLINE').map((entity) =>
      toSheetRect(entity, sheet.stock, 1 / 25.4),
    );
    const expected = sheet.layout.placements.map((placement) => {
      const part = sheet.parts.find((p) => p.id === placement.partId);
      if (!part) throw new Error('unreachable');
      return placementRect(part, placement);
    });
    expectRectsClose(actual, expected);
  });

  it('puts the sheet outline and the trim line where they belong', () => {
    const sheet = firstSheet('bookshelf');
    const parsed = parseDxf(render(sheet));

    const outline = entitiesOn(parsed, DXF_LAYERS.sheet, 'POLYLINE')[0];
    const trim = entitiesOn(parsed, DXF_LAYERS.trim, 'POLYLINE')[0];
    expect(outline).toBeDefined();
    expect(trim).toBeDefined();
    if (!outline || !trim) return;

    expectRectsClose(
      [toSheetRect(outline, sheet.stock, 1)],
      [{ x: 0, y: 0, width: sheet.stock.width, height: sheet.stock.height }],
    );
    expectRectsClose(
      [toSheetRect(trim, sheet.stock, 1)],
      [usableArea(sheet.stock, sheet.config.edgeTrim)],
    );
  });

  it('sets the extents to the sheet, in exported units', () => {
    for (const displayUnit of Object.keys(UNIT_SCALE) as DisplayUnit[]) {
      const sheet = firstSheet('bookshelf');
      const parsed = parseDxf(render(sheet, { displayUnit }));
      const scale = UNIT_SCALE[displayUnit];

      const min = parsed.header.get('$EXTMIN') ?? [];
      const max = parsed.header.get('$EXTMAX') ?? [];
      expect(Number(min[0]?.value)).toBeCloseTo(0, 6);
      expect(Number(min[1]?.value)).toBeCloseTo(0, 6);
      expect(Number(max[0]?.value)).toBeCloseTo(sheet.stock.width * scale, 4);
      expect(Number(max[1]?.value)).toBeCloseTo(sheet.stock.height * scale, 4);
    }
  });
});

describe('renderSheetDxf Y axis', () => {
  it('flips sheet space into DXF space about the sheet height', () => {
    const stock: Stock = {
      id: 's',
      materialId: 'm',
      width: 2440,
      height: 1220,
      qty: 1,
      grainAxis: 'x',
    };
    const to = sheetToDxf(stock, 1);

    // Our origin is the top-left corner; DXF's is the bottom-left.
    expect(to(0, 0)).toEqual({ x: 0, y: 1220 });
    expect(to(0, 1220)).toEqual({ x: 0, y: 0 });
    expect(to(2440, 610)).toEqual({ x: 2440, y: 610 });

    // ... and the scale applies to both axes.
    expect(sheetToDxf(stock, 1 / 10)(1000, 220)).toEqual({ x: 100, y: 100 });
  });

  it('never writes negative zero', () => {
    const stock: Stock = {
      id: 's',
      materialId: 'm',
      width: 100,
      height: 100,
      qty: 1,
      grainAxis: 'x',
    };
    expect(Object.is(sheetToDxf(stock, 1)(0, 100).y, -0)).toBe(false);
    expect(render(firstSheet('bookshelf'))).not.toContain('-0.0');
  });

  it('puts a part cut from the top-left of the sheet in the top-left of the drawing', () => {
    // The quadrant assertion. A mirrored drawing passes every overlap check,
    // opens without complaint, and cuts grain-locked parts the wrong way round.
    const sheet = firstSheet('bookshelf');
    const parsed = parseDxf(render(sheet));

    const topLeft = sheet.layout.placements.reduce((best, placement) => {
      const part = sheet.parts.find((p) => p.id === placement.partId);
      if (!part) return best;
      const rect = placementRect(part, placement);
      const bestPart = sheet.parts.find((p) => p.id === best.partId);
      if (!bestPart) return placement;
      const bestRect = placementRect(bestPart, best);
      return rect.x + rect.y < bestRect.x + bestRect.y ? placement : best;
    });
    const part = sheet.parts.find((p) => p.id === topLeft.partId);
    expect(part).toBeDefined();
    if (!part) return;
    const rect = placementRect(part, topLeft);

    // Find the outline that came from that placement and check where it landed.
    const outlines = entitiesOn(parsed, DXF_LAYERS.parts, 'POLYLINE');
    const match = outlines.find((entity) => {
      const back = toSheetRect(entity, sheet.stock, 1);
      return Math.abs(back.x - rect.x) < 1e-6 && Math.abs(back.y - rect.y) < 1e-6;
    });
    expect(match).toBeDefined();
    if (!match) return;

    const maxY = Math.max(...match.points.map((p) => p.y));
    const minX = Math.min(...match.points.map((p) => p.x));
    // Near the top of a Y-up drawing, and near its left edge.
    expect(maxY).toBeCloseTo(sheet.stock.height - rect.y, 6);
    expect(maxY).toBeGreaterThan(sheet.stock.height / 2);
    expect(minX).toBeLessThan(sheet.stock.width / 2);
  });
});

describe('renderSheetDxf units', () => {
  const cases: [DisplayUnit, number][] = [
    ['imperial-fraction', 1],
    ['imperial-decimal', 1],
    ['metric-mm', 4],
  ];

  it.each(cases)('declares $INSUNITS for %s', (displayUnit, insunits) => {
    const parsed = parseDxf(render(firstSheet('bookshelf'), { displayUnit }));
    expect(Number(parsed.header.get('$INSUNITS')?.[0]?.value)).toBe(insunits);
  });

  it('writes coordinates in the declared unit', () => {
    const sheet = firstSheet('bookshelf');
    for (const [displayUnit] of cases) {
      const parsed = parseDxf(render(sheet, { displayUnit }));
      const outline = entitiesOn(parsed, DXF_LAYERS.sheet, 'POLYLINE')[0];
      expect(outline).toBeDefined();
      const width = Math.max(...(outline?.points.map((p) => p.x) ?? [0]));
      expect(width).toBeCloseTo(sheet.stock.width * UNIT_SCALE[displayUnit], 4);
    }
  });

  it("labels dimensions in the user's unit", () => {
    const sheet = firstSheet('bookshelf');
    const metric = parseDxf(render(sheet, { displayUnit: 'metric-mm' }));
    const imperial = parseDxf(render(sheet, { displayUnit: 'imperial-fraction' }));

    const dims = (parsed: ParsedDxf) =>
      entitiesOn(parsed, DXF_LAYERS.labels, 'TEXT')
        .map((e) => e.text ?? '')
        .filter((text) => text.includes(' x '));

    expect(dims(metric).length).toBeGreaterThan(0);
    expect(dims(metric)).not.toEqual(dims(imperial));
    // A fraction is what a woodworker reads off a tape, and it has to survive
    // into CAD as text rather than being silently decimalised.
    expect(dims(imperial).some((text) => text.includes('/'))).toBe(true);
  });
});

describe('renderSheetDxf cut lines', () => {
  it('draws none unless a plan is supplied and asked for', () => {
    const sheet = firstSheet('bookshelf');
    expect(entitiesOn(parseDxf(render(sheet)), DXF_LAYERS.cuts)).toHaveLength(0);
    expect(
      entitiesOn(parseDxf(render(sheet, { cutPlan: planFor(sheet) })), DXF_LAYERS.cuts),
    ).toHaveLength(0);
    expect(
      entitiesOn(parseDxf(render(sheet, { showCutLines: true })), DXF_LAYERS.cuts),
    ).toHaveLength(0);
  });

  it('draws one line per step when asked', () => {
    const sheet = firstSheet('bookshelf');
    const plan = planFor(sheet);
    expect(plan.status).toBe('complete');

    const parsed = parseDxf(render(sheet, { cutPlan: plan, showCutLines: true }));
    const lines = entitiesOn(parsed, DXF_LAYERS.cuts, 'LINE');
    expect(lines).toHaveLength(plan.steps.length);

    // Every blade line sits on its step's position, in the flipped axis.
    for (const step of plan.steps) {
      const want = step.axis === 'x' ? step.at : sheet.stock.height - step.at;
      const found = lines.some((l) => {
        const start = l.points[0];
        if (!start) return false;
        return Math.abs((step.axis === 'x' ? start.x : start.y) - want) < 1e-6;
      });
      expect(found).toBe(true);
    }
  });

  it('draws nothing from a plan that proved nothing', () => {
    // A plan that hit its budget or found no cut order carries no steps at all,
    // and a partial set of blade lines is worse than none.
    const sheet = firstSheet('bookshelf');
    const plan = planFor(sheet);
    for (const status of ['unverified', 'invalid'] as const) {
      const stalled: CutPlan = { ...plan, status, steps: [] };
      const parsed = parseDxf(render(sheet, { cutPlan: stalled, showCutLines: true }));
      expect(entitiesOn(parsed, DXF_LAYERS.cuts)).toHaveLength(0);
    }
  });
});

describe('renderSheetDxf provenance', () => {
  it('records the saw settings the layout was packed for', () => {
    const sheet = firstSheet('bookshelf');
    const dxf = render(sheet);
    expect(dxf).toContain(sheet.material.name);
    expect(dxf).toContain(`kerf: ${sheet.config.kerf}mm`);
    expect(dxf).toContain(`edge trim: ${sheet.config.edgeTrim}mm`);
    expect(dxf).toContain('generated: 2026-01-15T09:30:00.000Z');
    expect(dxf).toContain('drawing units: mm');
  });

  it('states the drawing unit it actually wrote', () => {
    const sheet = firstSheet('bookshelf');
    expect(render(sheet, { displayUnit: 'imperial-fraction' })).toContain('drawing units: in');
    expect(render(sheet, { displayUnit: 'metric-mm' })).toContain('drawing units: mm');
  });

  it('keeps comments at the head of the file, where they are legal', () => {
    const pairs = toPairs(render(firstSheet('bookshelf')));
    let lastComment = -1;
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i]?.code === 999) lastComment = i;
    }
    const firstSection = pairs.findIndex((pair) => pair.code === 0 && pair.value === 'SECTION');
    expect(lastComment).toBeGreaterThanOrEqual(0);
    expect(lastComment).toBeLessThan(firstSection);
  });
});

describe('golden file', () => {
  it('matches the bookshelf fixture', async () => {
    const sheet = firstSheet('bookshelf');
    const dxf = render(sheet, { cutPlan: planFor(sheet), showCutLines: true });
    await expect(dxf).toMatchFileSnapshot('./golden/bookshelf-sheet-1.dxf');
  });
});
