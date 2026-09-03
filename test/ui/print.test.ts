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
/**
 * Solved projects, cached by fixture name.
 *
 * A nest fixture takes seconds to solve and several tests want the same one.
 * The solver is deterministic, so the cached project is what a second solve
 * would have produced. Callers that need to vary something derive a copy rather
 * than mutating this.
 */
const projectCache = new Map<string, Project>();

function project(fixtureName: string): Project {
  const cached = projectCache.get(fixtureName);
  if (cached) return cached;
  const built = solveProject(fixtureName);
  projectCache.set(fixtureName, built);
  return built;
}

function solveProject(fixtureName: string): Project {
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

/**
 * The printed page for a nested job.
 *
 * The paper is the thing that physically travels to the machine, so it is the
 * one output where getting this wrong has a cost: a printed nested layout that
 * looks like every other cut sheet is an invitation to take it to a table saw,
 * where the first cut ruins the sheet. Nothing else in the app can correct that
 * once the paper is out of the printer.
 */
const NEST_SOLVE_TIMEOUT_MS = 60_000;

describe('a nested printout is never mistaken for a sawn one', {
  timeout: NEST_SOLVE_TIMEOUT_MS,
}, () => {
  /**
   * Mirrors what `useCutListState` does in nest mode: no cut plans at all.
   * Building them and finding them invalid is the same end state by a slower
   * road, and the app deliberately does not take it.
   */
  function nestProject(fixtureName: string): Project {
    const p = project(fixtureName);
    return { ...p, plans: [], planByInstanceId: new Map() };
  }

  it('says which machine the sheets are for', () => {
    const markup = render(nestProject('nest-triangles'));
    expect(markup).toContain('Machine settings');
    expect(markup).toContain('CNC router');
    expect(markup).toContain('Cutter diameter');
    expect(markup).not.toContain('Table saw');
  });

  it('still calls a kerf a kerf on a table saw', () => {
    const markup = render(project('bookshelf'));
    expect(markup).toContain('Table saw');
    expect(markup).toContain('>Kerf<');
    expect(markup).not.toContain('Cutter diameter');
  });

  it('warns in as many words that these sheets cannot go to a table saw', () => {
    expect(render(nestProject('nest-triangles'))).toContain('cannot be cut on a table saw');
  });

  it('prints no cut sequence, no blade lines, and no note about either', () => {
    const markup = render(nestProject('nest-triangles'));
    expect(markup).not.toContain('Cut sequence');
    // The overlay's step badges. Their absence is the diagram agreeing with the
    // rest of the page rather than carrying an order nobody derived.
    expect(count(markup, 'Cut 1')).toBe(0);
    // The footnote below the summary used to explain how cut sequences are
    // ordered, on every page ever printed. On a nested job it described
    // something that is not on the paper.
    expect(markup).not.toContain('valid order of operations');
    // The half that holds on any machine stays.
    expect(markup).toContain('Check every dimension before cutting.');
  });

  it('names the angles a nested part was actually turned to', () => {
    // The cut list said "turned 90°" for anything off square, which was safe
    // when a saw's only other orientation *was* 90°. A part nested at 270° that
    // the page calls 90° is a number an operator would check their setup
    // against, and it is wrong.
    //
    // Every angle actually used has to appear, and the pre-M7 claim that they
    // are all 90° has to be gone - `not.toContain('turned 90°')` is the half
    // that would have failed before this change.
    const p = nestProject('nest-triangles');
    const angles = [
      ...new Set(
        p.result.layouts
          .flatMap((l) => l.placements)
          .map((pl) => pl.angleDeg)
          .filter((a) => a !== 0),
      ),
    ].sort((a, b) => a - b);
    expect(angles).toEqual([90, 180, 270]);

    const markup = render(p);
    expect(markup).toContain('turned 90°/180°/270°');
    expect(markup).not.toContain('· turned 90°<');
  });

  it('records the rotation count, which is the layout it produced', () => {
    // Re-solving at a different step count gives a different layout, so a sheet
    // in the shop has to say which one it came from to be reproducible.
    const markup = render(nestProject('nest-triangles'));
    expect(markup).toContain('Rotations');
  });

  it('does not offer a rotation count for a saw, which has no such choice', () => {
    expect(render(project('bookshelf'))).not.toContain('Rotations');
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
