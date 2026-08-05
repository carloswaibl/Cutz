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

/** Solve a fixture and hand back its first sheet with everything needed to draw it. */
function firstSheet(fixtureName: string): Sheet {
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
