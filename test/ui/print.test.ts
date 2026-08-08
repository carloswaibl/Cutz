/**
 * Printed document tests.
 *
 * The printed cut sheet is the only output of this project that nobody can
 * check against anything else: a woodworker at the saw has the paper and the
 * wood, and if the paper is wrong the wood is scrap. So the assertions here are
 * about the facts on the page - one page per sheet, the same piece letters on
 * the diagram and in the tables, every part accounted for, and no cut sequence
 * shown for a plan that was not actually proved.
 *
 * Rendered through `renderToStaticMarkup` with `createElement`, the same way
 * `src/export/svg.ts` renders the exported drawing. That keeps these tests in
 * the project's plain-Node Vitest environment: no jsdom, no `.tsx` in the test
 * glob, no new dependency.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildCutPlans, type CutPlan } from '../../src/domain/cutplan';
import { parseStockInstanceId } from '../../src/domain/instances';
import type { Layout, Material, Part, Result, SolverConfig, Stock } from '../../src/domain/types';
import { solve } from '../../src/solver';
import { CutSequenceList } from '../../src/ui/components/print/CutSequenceList';
import { type PrintableLayout, PrintDocument } from '../../src/ui/components/print/PrintDocument';
import { loadFixture } from '../fixtures/index';

interface Project {
  layouts: PrintableLayout[];
  parts: Part[];
  materials: Material[];
  stock: Stock[];
  config: SolverConfig;
  result: Result;
  plans: CutPlan[];
  planByInstanceId: Map<string, CutPlan>;
}

/** Solve a fixture and assemble everything `PrintDocument` needs. */
function project(fixtureName: string): Project {
  const fixture = loadFixture(fixtureName);
  const result = solve(fixture.parts, fixture.stock, fixture.config);
  const plans = buildCutPlans(result, {
    parts: fixture.parts,
    stock: fixture.stock,
    materials: fixture.materials,
    config: fixture.config,
  });

  const layouts = result.layouts.map((layout: Layout): PrintableLayout => {
    const ref = parseStockInstanceId(layout.stockInstanceId);
    if (!ref) throw new Error(`unparseable stock instance id "${layout.stockInstanceId}"`);
    const stock = fixture.stock.find((s) => s.id === ref.stockId);
    if (!stock) throw new Error(`no stock for "${layout.stockInstanceId}"`);
    const material = fixture.materials.find((m) => m.id === stock.materialId);
    if (!material) throw new Error(`no material for stock "${stock.id}"`);
    return { layout, stock, material };
  });

  return {
    layouts,
    parts: fixture.parts,
    materials: fixture.materials,
    stock: fixture.stock,
    config: fixture.config,
    result,
    plans,
    planByInstanceId: new Map(plans.map((plan) => [plan.stockInstanceId, plan])),
  };
}

function render(p: Project, overrides: Partial<Parameters<typeof PrintDocument>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PrintDocument, {
      layouts: p.layouts,
      parts: p.parts,
      unplacedParts: p.result.unplacedParts,
      config: p.config,
      displayUnit: 'imperial-fraction',
      fractionDenominator: 16,
      planByInstanceId: p.planByInstanceId,
      showCutSequence: true,
      ...overrides,
    }),
  );
}

/** Occurrences of a substring, for counting pages and sections. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('PrintDocument', () => {
  it('emits one sheet page per layout, plus a single summary page', () => {
    const p = project('bookshelf');
    expect(p.layouts.length).toBeGreaterThan(1);

    const html = render(p);

    // Every page carries `cutz-print-page`; the summary adds `-page-last`, so
    // the totals separate cleanly.
    expect(count(html, 'cutz-print-page-last')).toBe(1);
    expect(count(html, 'cutz-print-page')).toBe(p.layouts.length + 2);

    for (let n = 1; n <= p.layouts.length; n++) {
      expect(html).toContain(`Sheet ${n} of ${p.layouts.length}`);
    }
    expect(html).toContain('Project summary');
  });

  it('gives every sheet page its own cut list and cut sequence', () => {
    const p = project('cabinet-carcass');
    const html = render(p);

    // One "Cut list" heading per sheet page, plus "Full cut list" on the summary.
    expect(count(html, '>Cut list<')).toBe(p.layouts.length);
    expect(count(html, '>Full cut list<')).toBe(1);
    expect(count(html, '>Cut sequence<')).toBe(p.layouts.length);
  });

  it('numbers each sheet’s cuts from 1, with no gaps', () => {
    const p = project('bookshelf');

    for (const plan of p.plans) {
      expect(plan.status).toBe('complete');
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps.map((step) => step.index)).toEqual(
        plan.steps.map((_step, index) => index + 1),
      );
    }
  });

  it('accounts for every placement on the sheet it sits on', () => {
    const p = project('drawer-boxes');
    const html = render(p);

    // The per-sheet captions add up to the placements the solver made.
    const captions = [...html.matchAll(/(\d+) pieces? from this sheet/g)].map((m) => Number(m[1]));
    expect(captions).toHaveLength(p.layouts.length);

    const placed = p.layouts.map((entry) => entry.layout.placements.length);
    expect(captions).toEqual(placed);

    const total = placed.reduce((sum, n) => sum + n, 0);
    expect(html).toContain(`${total} pieces across ${p.layouts.length} sheets`);
  });

  it('puts unplaced parts on the summary page', () => {
    const p = project('oversized-part');
    expect(p.result.unplacedParts.length).toBeGreaterThan(0);

    const html = render(p);

    expect(html).toContain('Not placed - buy more stock');
    for (const entry of p.result.unplacedParts) {
      const part = p.parts.find((candidate) => candidate.id === entry.partId);
      if (!part) throw new Error(`unplaced part "${entry.partId}" is not in the fixture`);
      expect(html).toContain(part.label);
      expect(html).toContain(`${entry.qty} missing`);
    }
  });

  it('shows piece letters on the diagram and in the cut list together', () => {
    const p = project('bookshelf');
    const html = render(p);

    const firstPlan = p.plans[0];
    if (!firstPlan) throw new Error('bookshelf produced no cut plans');
    const partPieces = firstPlan.pieces.filter((piece) => piece.placement !== null);
    expect(partPieces.length).toBeGreaterThan(0);

    // Every letter drawn on a part appears somewhere in the document text: the
    // badge on the diagram and the "Pieces" column of the cut list. A letter on
    // one and not the other is a printout the operator cannot follow.
    for (const piece of partPieces) {
      expect(html).toContain(`>${piece.id}</text>`);
    }
  });

  it('drops the whole cut sequence when the toggle is off', () => {
    const p = project('bookshelf');

    const on = render(p);
    const off = render(p, { showCutSequence: false });

    expect(count(on, '>Cut sequence<')).toBe(p.layouts.length);
    expect(count(off, '>Cut sequence<')).toBe(0);
    // The step-number badges on the diagram go with it.
    expect(off.length).toBeLessThan(on.length);
    // The diagrams and cut lists stay.
    expect(count(off, '>Cut list<')).toBe(p.layouts.length);
    expect(count(off, '<svg')).toBe(p.layouts.length);
  });

  it('says which material a filtered printout covers', () => {
    const p = project('mixed-stock');

    expect(render(p)).toContain('All materials');
    expect(render(p, { materialFilterName: 'Baltic Birch' })).toContain(
      'Filtered to Baltic Birch - other materials are not on this printout',
    );
  });

  it('renders nothing at all when there is nothing to print', () => {
    const p = project('tight-fit');
    expect(render(p, { layouts: [] })).toBe('');
  });

  /**
   * A sheet taller than it is wide is height-limited on a page, so it leaves
   * two-thirds of the width empty beside it and the cut list goes there. A wide
   * sheet has no such gap and takes the full width with the list underneath.
   * Getting this backwards prints a 4x8 sheet as a thumbnail with a column of
   * white space under it, which is the whole page wasted.
   */
  it('puts the cut list beside a tall sheet and under a wide one', () => {
    // `tight-fit` is a 4x8 sheet standing up; every other fixture lies flat.
    const tall = project('tight-fit');
    expect(tall.layouts[0]?.stock.height).toBeGreaterThan(tall.layouts[0]?.stock.width ?? 0);
    expect(render(tall)).toContain('w-[45%]');

    const wide = project('bookshelf');
    expect(wide.layouts[0]?.stock.width).toBeGreaterThan(wide.layouts[0]?.stock.height ?? 0);
    expect(render(wide)).not.toContain('w-[45%]');
  });
});

describe('CutSequenceList', () => {
  const p = project('bookshelf');
  const plan = p.plans[0];
  if (!plan) throw new Error('bookshelf produced no cut plans');

  function renderList(override: CutPlan): string {
    return renderToStaticMarkup(
      createElement(CutSequenceList, {
        plan: override,
        parts: p.parts,
        displayUnit: 'imperial-fraction',
        fractionDenominator: 16,
        variant: 'print',
      }),
    );
  }

  it('labels cuts rip or crosscut against the sheet grain', () => {
    const html = renderList(plan);
    expect(html).toContain('Rip');
    expect(html).toContain('Crosscut');
  });

  it('shows no steps and an explanation for an unprovable layout', () => {
    const html = renderList({ ...plan, steps: [], status: 'unverified' });

    expect(html).toContain('Cut sequence unavailable for this sheet');
    expect(html).not.toContain('Fence');
    expect(html).not.toContain('Rip');
  });

  it('says plainly when a layout cannot be cut on a table saw', () => {
    const html = renderList({ ...plan, steps: [], status: 'invalid' });

    expect(html).toContain('cannot be cut on a table saw');
    expect(html).not.toContain('Fence');
  });

  it('reads out "trim flush" rather than a fence setting the saw has no stop for', () => {
    const step = plan.steps[0];
    if (!step) throw new Error('the first bookshelf plan has no steps');

    const html = renderList({
      ...plan,
      steps: [{ ...step, fence: -1.5875 }],
    });

    expect(html).toContain('trim flush');
    // A negative length must never reach the page as a number. Matching text
    // content only - Tailwind class names are full of `-1`.
    expect(html).not.toMatch(/>\s*-[\d.]/);
  });

  it('names the finished part a cut yields, not just its letter', () => {
    const html = renderList(plan);
    const finished = plan.pieces.find((piece) => piece.placement !== null);
    if (!finished) throw new Error('the first bookshelf plan finishes no parts');

    const part = p.parts.find((candidate) => candidate.id === finished.placement?.partId);
    if (!part) throw new Error('a finished piece names a part the fixture does not have');
    expect(html).toContain(part.label);
  });
});
