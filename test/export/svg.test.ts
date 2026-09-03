/**
 * SVG export tests.
 *
 * Two things matter here and neither is visual. First, dimensional accuracy: a
 * drawing that opens at the wrong scale looks completely correct and produces
 * wrong parts, so the sheet's physical size and geometry are parsed back out of
 * the emitted file and compared to the stock it came from. Second, that the
 * file is standalone - no Tailwind classes, no dark screen palette, nothing
 * that only means something inside the app.
 *
 * The golden files under `golden/` are real SVGs. Open them.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildCutPlan, type CutPlan } from '../../src/domain/cutplan';
import { placementPolygon } from '../../src/domain/polygon';
import type { Layout, Material, Part, SolverConfig, Stock } from '../../src/domain/types';
import { renderSheetSvg } from '../../src/export/svg';
import { solve } from '../../src/solver';
import { figureViewBox, SheetFigure } from '../../src/ui/components/SheetFigure';
import { SCREEN_THEME } from '../../src/ui/components/sheetTheme';
import { loadFixture } from '../fixtures/index';

const GENERATED_AT = new Date('2026-01-15T09:30:00.000Z');

interface Sheet {
  layout: Layout;
  stock: Stock;
  material: Material;
  parts: Part[];
  config: SolverConfig;
  sheetCount: number;
}

/**
 * Solved sheets, cached by fixture name.
 *
 * A nest fixture takes seconds to solve, and several tests want the same one.
 * Solving it once per file is what keeps them inside a sane budget - and the
 * solver is deterministic, so a cached result is the same object every call
 * would have produced.
 */
const sheetCache = new Map<string, Sheet>();

/** Solve a fixture and hand back its first sheet with everything needed to draw it. */
function firstSheet(fixtureName: string): Sheet {
  const cached = sheetCache.get(fixtureName);
  if (cached) return cached;
  const sheet = solveFirstSheet(fixtureName);
  sheetCache.set(fixtureName, sheet);
  return sheet;
}

function solveFirstSheet(fixtureName: string): Sheet {
  const fixture = loadFixture(fixtureName);
  const result = solve(fixture.parts, fixture.stock, fixture.config);
  const layout = result.layouts[0];
  if (!layout) throw new Error(`fixture "${fixtureName}" solved to no layouts`);
  const stockId = layout.stockInstanceId.split('#')[0];
  const stock = fixture.stock.find((s) => s.id === stockId) ?? fixture.stock[0];
  if (!stock) throw new Error(`fixture "${fixtureName}" has no stock`);
  const material = fixture.materials.find((m) => m.id === stock.materialId);
  if (!material) throw new Error(`fixture "${fixtureName}" has no material for its stock`);
  return {
    layout,
    stock,
    material,
    parts: fixture.parts,
    config: fixture.config,
    sheetCount: result.layouts.length,
  };
}

function render(sheet: Sheet, overrides: Partial<Parameters<typeof renderSheetSvg>[0]> = {}) {
  return renderSheetSvg({
    layout: sheet.layout,
    stock: sheet.stock,
    parts: sheet.parts,
    material: sheet.material,
    config: sheet.config,
    displayUnit: 'metric-mm',
    fractionDenominator: 16,
    sheetNumber: 1,
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

/** Read a numeric attribute off the first tag that carries the given marker. */
function attr(markup: string, tag: string, name: string): string | null {
  const tagMatch = markup.match(new RegExp(`<${tag}\\b[^>]*>`));
  if (!tagMatch) return null;
  const valueMatch = tagMatch[0].match(new RegExp(`\\b${name}="([^"]*)"`));
  return valueMatch?.[1] ?? null;
}

// ---------------------------------------------------------------------------

describe('renderSheetSvg', () => {
  it('matches the golden file for the bookshelf fixture', async () => {
    const svg = render(firstSheet('bookshelf'));
    await expect(svg).toMatchFileSnapshot('./golden/bookshelf-sheet-1.svg');
  });

  it('emits a standalone XML document', () => {
    const svg = render(firstSheet('bookshelf'));
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(svg).toContain('<svg ');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('records the saw settings the layout was packed for', () => {
    const sheet = firstSheet('bookshelf');
    const svg = render(sheet);
    const comment = svg.slice(svg.indexOf('<!--'), svg.indexOf('-->') + 3);
    expect(comment).toContain(sheet.material.name);
    expect(comment).toContain(`kerf: ${sheet.config.kerf}mm`);
    expect(comment).toContain(`edge trim: ${sheet.config.edgeTrim}mm`);
    expect(comment).toContain('generated: 2026-01-15T09:30:00.000Z');
  });

  it('never emits a double dash inside the metadata comment', () => {
    const sheet = firstSheet('bookshelf');
    // A material name that would produce an XML comment no parser will open.
    const material: Material = { ...sheet.material, name: 'ply -- factory seconds' };
    const svg = render({ ...sheet, material }, { material });
    const comment = svg.slice(svg.indexOf('<!--') + 4, svg.indexOf('-->'));
    expect(comment).not.toContain('--');
  });

  it('states its physical size in millimetres, matching the viewBox', () => {
    const sheet = firstSheet('bookshelf');
    const svg = render(sheet);
    const box = figureViewBox(sheet.stock, true);

    const width = attr(svg, 'svg', 'width');
    const height = attr(svg, 'svg', 'height');
    expect(width).not.toBeNull();
    expect(height).not.toBeNull();
    expect(width?.endsWith('mm')).toBe(true);
    expect(height?.endsWith('mm')).toBe(true);
    expect(Number.parseFloat(width ?? '')).toBeCloseTo(box.width, 6);
    expect(Number.parseFloat(height ?? '')).toBeCloseTo(box.height, 6);

    const viewBox = attr(svg, 'svg', 'viewBox')?.split(' ').map(Number) ?? [];
    expect(viewBox).toHaveLength(4);
    expect(viewBox[0]).toBeCloseTo(box.x, 6);
    expect(viewBox[1]).toBeCloseTo(box.y, 6);
    expect(viewBox[2]).toBeCloseTo(box.width, 6);
    expect(viewBox[3]).toBeCloseTo(box.height, 6);
  });

  it('draws the sheet at its true size in user units', () => {
    // Imperial display, so the labels are in inches while the geometry stays mm.
    // Getting this backwards is the failure that produces a plausible-looking
    // drawing at 25.4x the intended scale.
    const sheet = firstSheet('bookshelf');
    const svg = render(sheet, { displayUnit: 'imperial-fraction' });

    // The sheet outline is the first rect drawn after the painted background.
    const rects = [...svg.matchAll(/<rect\b[^>]*>/g)].map((m) => m[0]);
    const sheetRect = rects.find((r) => r.includes('rx="2"'));
    expect(sheetRect).toBeDefined();
    expect(Number(sheetRect?.match(/\bwidth="([^"]*)"/)?.[1])).toBeCloseTo(sheet.stock.width, 6);
    expect(Number(sheetRect?.match(/\bheight="([^"]*)"/)?.[1])).toBeCloseTo(sheet.stock.height, 6);

    // ... and the physical size is unaffected by the display unit.
    const metric = render(sheet, { displayUnit: 'metric-mm' });
    expect(attr(svg, 'svg', 'width')).toBe(attr(metric, 'svg', 'width'));
    expect(attr(svg, 'svg', 'height')).toBe(attr(metric, 'svg', 'height'));
  });

  it('leaks no Tailwind classes into the file', () => {
    for (const name of ['bookshelf', 'mixed-stock', 'tight-fit']) {
      expect(render(firstSheet(name))).not.toContain('class=');
    }
  });

  it('uses the print palette, not the dark screen theme', () => {
    const svg = render(firstSheet('bookshelf'));
    expect(svg).toContain('background:#ffffff');
    // The screen's sheet body and diagram ground.
    expect(svg).not.toContain('#1e293b');
    // A painted background rect, because CSS does not travel with the file.
    expect(svg).toMatch(/<rect\b[^>]*fill="#ffffff"/);
  });

  it('is deterministic', () => {
    const sheet = firstSheet('cabinet-carcass');
    expect(render(sheet)).toBe(render(sheet));
  });
});

describe('renderSheetSvg cut-plan overlays', () => {
  it('draws nothing from the plan unless asked', () => {
    const sheet = firstSheet('bookshelf');
    const svg = render(sheet, { cutPlan: planFor(sheet) });
    expect(svg).not.toContain('<circle');
  });

  it('numbers every cut when cut lines are on', () => {
    const sheet = firstSheet('bookshelf');
    const plan = planFor(sheet);
    expect(plan.status).toBe('complete');

    const svg = render(sheet, { cutPlan: plan, showCutLines: true });
    // One numbered badge per step. Circles are used nowhere else in the figure.
    expect([...svg.matchAll(/<circle\b/g)]).toHaveLength(plan.steps.length);
    for (const step of plan.steps) {
      expect(svg).toContain(`>${step.index}</text>`);
    }
  });

  it('labels each finished part with its piece letter', () => {
    const sheet = firstSheet('bookshelf');
    const plan = planFor(sheet);
    const svg = render(sheet, { cutPlan: plan, showPartNumbers: true });

    const finished = plan.pieces.filter((piece) => piece.placement !== null);
    expect(finished.length).toBe(sheet.layout.placements.length);
    for (const piece of finished) {
      expect(svg).toContain(`>${piece.id}</text>`);
    }
  });

  it('keeps step numbers inside the drawing', () => {
    // The first cuts of a sheet start at its edge, so an unclamped badge sits
    // outside the viewBox and is sliced in half by the drawing boundary.
    const sheet = firstSheet('bookshelf');
    const box = figureViewBox(sheet.stock, true);
    const svg = render(sheet, { cutPlan: planFor(sheet), showCutLines: true });

    for (const match of svg.matchAll(/<circle\b[^>]*>/g)) {
      const tag = match[0];
      const cx = Number(tag.match(/\bcx="([^"]*)"/)?.[1]);
      const cy = Number(tag.match(/\bcy="([^"]*)"/)?.[1]);
      expect(cx).toBeGreaterThanOrEqual(box.x);
      expect(cy).toBeGreaterThanOrEqual(box.y);
      expect(cx).toBeLessThanOrEqual(box.x + box.width);
      expect(cy).toBeLessThanOrEqual(box.y + box.height);
    }
  });
});

describe('SheetFigure on screen', () => {
  it('matches the golden screen rendering', async () => {
    // Guards the theme extraction and the SheetSvg/SheetFigure split: the screen
    // diagram has to come out of the refactor unchanged, and it is the one
    // output no export test would otherwise cover.
    const sheet = firstSheet('bookshelf');
    const markup = renderToStaticMarkup(
      createElement(SheetFigure, {
        layout: sheet.layout,
        stock: sheet.stock,
        parts: sheet.parts,
        material: sheet.material,
        config: sheet.config,
        displayUnit: 'metric-mm',
        fractionDenominator: 16,
        theme: SCREEN_THEME,
        hoveredPartId: null,
        onHoverPart: () => {},
      }),
    );
    await expect(markup).toMatchFileSnapshot('./golden/screen-sheet-1.svg');
  });
});

/**
 * What the diagram draws is decided by the machine, not by the shape.
 *
 * The distinction is the whole of `docs/plan-m7.md` §4's rendering decision and
 * it is not cosmetic: the boundary drawn around a part is a claim about what the
 * machine will cut. Drawing a curve on a table-saw sheet claims a cut no blade
 * makes, and would sit underneath a cut-sequence overlay contradicting it.
 */
/**
 * A nest solve is seconds, not milliseconds, and Vitest runs files in parallel
 * against a 5s default - the same contention `test/solver/nest/solver.test.ts`
 * hit in M7 PR 7. Same idiom and same reasoning: an explicit budget rather than
 * a smaller fixture, because a rectangle would not test what this claims.
 */
const NEST_SOLVE_TIMEOUT_MS = 60_000;

describe('mode decides what a part is drawn as', { timeout: NEST_SOLVE_TIMEOUT_MS }, () => {
  function screenMarkup(sheet: Sheet) {
    return renderToStaticMarkup(
      createElement(SheetFigure, {
        layout: sheet.layout,
        stock: sheet.stock,
        parts: sheet.parts,
        material: sheet.material,
        config: sheet.config,
        displayUnit: 'metric-mm',
        fractionDenominator: 16,
        theme: SCREEN_THEME,
      }),
    );
  }

  /** The same outlined parts and layout, re-labelled for the other machine. */
  function asMode(sheet: Sheet, mode: 'guillotine' | 'nest'): Sheet {
    return { ...sheet, config: { ...sheet.config, mode } };
  }

  it('draws a nested part as a polygon of its own outline', () => {
    const sheet = firstSheet('nest-triangles');
    const markup = screenMarkup(sheet);

    const shaped = sheet.parts.filter((p) => p.outline !== undefined);
    expect(shaped.length).toBeGreaterThan(0);

    // One polygon per placement, plus the grain arrowhead the sheet always has.
    const polygons = markup.match(/<polygon\b/g) ?? [];
    expect(polygons.length).toBeGreaterThanOrEqual(sheet.layout.placements.length);

    // A triangle is three points; a rect would be four and axis-aligned.
    const first = sheet.layout.placements[0];
    if (!first) throw new Error('nest-triangles solved to an empty sheet');
    const part = sheet.parts.find((p) => p.id === first.partId);
    if (!part) throw new Error('placement names a part the fixture does not have');
    const expected = placementPolygon(part, first)
      .map((p) => `${Math.round(p.x * 1000) / 1000},${Math.round(p.y * 1000) / 1000}`)
      .join(' ');
    expect(markup).toContain(`points="${expected}"`);
  });

  it('draws the same parts as bounding boxes on a table saw, with the shape hinted', () => {
    const sheet = asMode(firstSheet('nest-triangles'), 'guillotine');
    const markup = screenMarkup(sheet);

    // The cut boundary is a rect again - that is what the blade produces.
    const rects = markup.match(/<rect\b/g) ?? [];
    expect(rects.length).toBeGreaterThanOrEqual(sheet.layout.placements.length);

    // The shape is not thrown away, only demoted: it is drawn dashed, in the
    // hint colour, and never filled - a filled polygon would read as the part.
    expect(markup).toContain(SCREEN_THEME.partOutlineHint);
    expect(markup).toContain('stroke-dasharray="4 3"');
  });

  it('shows a nested part its actual angle, not a bare rotation glyph', () => {
    const sheet = firstSheet('nest-triangles');
    const turned = sheet.layout.placements.find((p) => p.angleDeg !== 0 && p.angleDeg !== 90);
    if (!turned) throw new Error('expected nest-triangles to turn a part off the axes');
    expect(screenMarkup(sheet)).toContain(`↻${Math.round(turned.angleDeg)}°`);
  });

  it('draws no kerf lines on a router', () => {
    // They are two axis-aligned dashes off a bounding box, which is a blade's
    // clearance. A router's is an offset band round the outline, so the saw's
    // version beside a nested part would claim a cut nobody makes.
    const nested = firstSheet('nest-triangles');
    expect(screenMarkup(nested)).not.toContain(SCREEN_THEME.kerfLine);
    expect(screenMarkup(asMode(nested, 'guillotine'))).toContain(SCREEN_THEME.kerfLine);
  });

  /**
   * Every part label drawn on a sheet, as the box it occupies.
   *
   * Width is estimated at a deliberately *narrower* advance than the renderer
   * assumes, so this test can only fail on a real overlap and never on the
   * estimate itself. It reads the markup rather than calling into the renderer's
   * own helper for the same reason: the property being asserted is what a
   * woodworker sees on the page.
   */
  function labelBoxes(markup: string) {
    const pattern =
      /<text x="([-\d.]+)" y="([-\d.]+)" text-anchor="middle" dominant-baseline="central"[^>]*font-size="([\d.]+)" font-weight="600"[^>]*>([^<]*)<\/text>/g;
    return [...markup.matchAll(pattern)].map((m) => {
      const x = Number(m[1]);
      const y = Number(m[2]);
      const size = Number(m[3]);
      const width = (m[4] ?? '').length * size * 0.5;
      return { text: m[4] ?? '', x: x - width / 2, y: y - size / 2, width, height: size };
    });
  }

  /**
   * Two L-brackets interlocked, hand-placed rather than solved.
   *
   * The bench fixtures nest parts that are large next to their own labels, so
   * they do not reproduce this. The hazard needs the opposite: parts small
   * enough that the text is wider than the material it names, which is the
   * ordinary case for imported hardware. Written out here so the geometry that
   * triggers it is visible rather than an emergent property of a solve.
   */
  function interlockedBrackets(): Sheet {
    const material: Material = { id: 'm', name: 'ply', thickness: 18, hasGrain: false };
    const stock: Stock = {
      id: 's',
      materialId: 'm',
      width: 1200,
      height: 800,
      qty: 1,
      grainAxis: 'y',
    };
    const part: Part = {
      id: 'p-l',
      label: 'L Bracket',
      width: 120,
      height: 100,
      qty: 2,
      materialId: 'm',
      rotationPolicy: 'free90',
      outline: [
        { x: 0, y: 0 },
        { x: 120, y: 0 },
        { x: 120, y: 30 },
        { x: 30, y: 30 },
        { x: 30, y: 100 },
        { x: 0, y: 100 },
      ],
    };
    return {
      layout: {
        stockInstanceId: 's#0',
        placements: [
          { partId: 'p-l', stockInstanceId: 's#0', x: 20, y: 20, angleDeg: 0 },
          // Turned into the first bracket's notch: the two footprints overlap,
          // which is the whole point of nesting and the reason the labels can.
          { partId: 'p-l', stockInstanceId: 's#0', x: 70, y: 20, angleDeg: 180 },
        ],
        wastePct: 0.5,
      },
      stock,
      material,
      parts: [part],
      config: { kerf: 3, edgeTrim: 5, seed: 1, mode: 'nest' },
      sheetCount: 1,
    };
  }

  it('drops a nested label rather than printing it over another part', () => {
    // Nesting is what creates the hazard. A saw's parts never share sheet area,
    // so a label centred in a part's box always sits on that part's material; a
    // router packs a neighbour into the concavity and the two boxes overlap by
    // design. Found on paper: two interlocked L-brackets printed as
    // `Part 1 ↻240°Part 1 ↻`, naming neither.
    const sheet = interlockedBrackets();
    const nested = labelBoxes(screenMarkup(sheet));
    const sawn = labelBoxes(screenMarkup(asMode(sheet, 'guillotine')));

    expect(sawn.length).toBeGreaterThan(0);
    expect(nested.length).toBeLessThan(sawn.length);

    for (let i = 0; i < nested.length; i++) {
      for (let j = i + 1; j < nested.length; j++) {
        const a = nested[i];
        const b = nested[j];
        if (!a || !b) continue;
        const clash =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(clash, `"${a.text}" overlaps "${b.text}"`).toBe(false);
      }
    }
  });
});
