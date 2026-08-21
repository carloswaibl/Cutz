// @vitest-environment jsdom

/**
 * The importer end to end.
 *
 * The golden blocks are the load-bearing tests and they are what exit criterion
 * 1 means: a real-shaped file in, the right parts at the right sizes out, with
 * the expected dimensions written down in a comment next to the assertion so a
 * reader can check them against the drawing rather than against the code that
 * produced them.
 *
 * The three files under `test/files/` are **reproductions** of Inkscape,
 * Illustrator and Fusion output, not captures - see the header comment in each
 * and `docs/plan-m4.md` §7. They carry each tool's idioms faithfully, but a
 * genuine export is still the stronger evidence and PR 4's browser pass is
 * where one belongs.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Part, SolverConfig, Stock } from '../../src/domain/types';
import { validateInputs } from '../../src/domain/validate';
import { MAX_SHAPES } from '../../src/import/errors';
import { importSvg } from '../../src/import/svg';
import type { ImportedPart, ImportOutcome, ImportWarningKind } from '../../src/import/types';

const MM_PER_PX = 25.4 / 96;

function load(name: string): string {
  return readFileSync(`test/files/${name}`, 'utf8');
}

function imported(name: string): Extract<ImportOutcome, { ok: true }> {
  const outcome = importSvg(load(name));
  if (!outcome.ok) throw new Error(`${name} failed to import: ${outcome.error.kind}`);
  return outcome;
}

function kinds(outcome: Extract<ImportOutcome, { ok: true }>): ImportWarningKind[] {
  return outcome.warnings.map((warning) => warning.kind);
}

/** Assert a row exists at these millimetre dimensions, and return it. */
function rowAt(parts: readonly ImportedPart[], width: number, height: number): ImportedPart {
  const found = parts.find(
    (part) => Math.abs(part.width - width) < 0.01 && Math.abs(part.height - height) < 0.01,
  );
  if (!found) {
    const listed = parts.map((p) => `${p.width.toFixed(3)}x${p.height.toFixed(3)}`).join(', ');
    throw new Error(`no row at ${width}x${height}mm. Found: ${listed}`);
  }
  return found;
}

// --- The reproductions ----------------------------------------------------

describe('an Inkscape-shaped file', () => {
  const outcome = imported('inkscape-shelf-unit.svg');

  it('reads its declared millimetres rather than assuming', () => {
    // width="2000mm" over viewBox="0 0 2000 1200" is 1mm per user unit.
    expect(outcome.scale).toEqual({ kind: 'declared', unit: 'mm', mmPerUnit: 1 });
  });

  it('reports the overall drawing size for the preview, in mm and in user units', () => {
    expect(outcome.drawingWidthMm).toBeCloseTo(2000, 6);
    expect(outcome.drawingHeightMm).toBeCloseTo(1200, 6);
    expect(outcome.extentWidth).toBeCloseTo(2000, 6);
    expect(outcome.extentHeight).toBeCloseTo(1200, 6);
  });

  it('produces the three parts the drawing shows, at their drawn sizes', () => {
    // Checked against the drawing: 2 sides at 800x300, 3 shelves at 564x300,
    // 1 back at 600x800.
    expect(outcome.parts).toHaveLength(3);
    expect(rowAt(outcome.parts, 800, 300).qty).toBe(2);
    expect(rowAt(outcome.parts, 564, 300).qty).toBe(3);
    expect(rowAt(outcome.parts, 600, 800).qty).toBe(1);
  });

  it('names parts from inkscape:label and title', () => {
    expect(rowAt(outcome.parts, 800, 300).label).toBe('Side Panel');
    expect(rowAt(outcome.parts, 564, 300).label).toBe('Shelf');
    expect(rowAt(outcome.parts, 600, 800).label).toBe('Back Panel');
  });

  it('skips the hidden construction layer without mentioning it', () => {
    // A hidden layer is geometry its author does not consider part of the
    // drawing, so dropping it is right and warning about it would be noise.
    expect(kinds(outcome)).not.toContain('degenerate-shape');
    expect(outcome.parts.every((part) => part.width !== 1980)).toBe(true);
  });

  it('names the dimension text it skipped', () => {
    const text = outcome.warnings.find((warning) => warning.message.includes('<text>'));
    expect(text?.kind).toBe('unsupported-element');
    expect(text?.count).toBe(1);
  });

  it('ignores inkscape:document-units, which describes the ruler not the document', () => {
    // The file's namedview says inches. Its width says 2000mm, so it is 2000mm.
    expect(outcome.scale).toMatchObject({ mmPerUnit: 1 });
  });
});

describe('an Illustrator-shaped file', () => {
  const outcome = imported('illustrator-drawer-boxes.svg');

  it('labels a px-dimensioned document as an assumption, not a declaration', () => {
    // This is the distinction the whole units policy turns on. Illustrator
    // writes px, the spec says 1/96in, and Inkscape before 0.92 said 1/90in.
    expect(outcome.scale).toEqual({ kind: 'assumed-px', mmPerUnit: MM_PER_PX });
  });

  it('converts px to mm at 96 per inch', () => {
    // Checked against the drawing: 400x150px sides and a 200x100px base.
    expect(outcome.parts).toHaveLength(2);
    const side = rowAt(outcome.parts, 400 * MM_PER_PX, 150 * MM_PER_PX);
    expect(side.qty).toBe(2);
    expect(side.width).toBeCloseTo(105.8333, 3);
    expect(rowAt(outcome.parts, 200 * MM_PER_PX, 100 * MM_PER_PX).qty).toBe(1);
  });

  it('decodes _xHHHH_ escapes in ids into names', () => {
    expect(rowAt(outcome.parts, 200 * MM_PER_PX, 100 * MM_PER_PX).label).toBe('18mm Base');
  });

  it('falls back to the group name for XMLID_ ids, which are not names', () => {
    expect(rowAt(outcome.parts, 400 * MM_PER_PX, 150 * MM_PER_PX).label).toBe('Drawer Sides 1');
  });

  it('says that its stylesheet was not read', () => {
    // `.st1{display:none}` hides the guides layer, and we do not parse CSS to
    // find that out - so we say so rather than silently including or excluding.
    expect(kinds(outcome)).toContain('stylesheet-not-read');
  });
});

describe('a Fusion-shaped file', () => {
  const outcome = imported('fusion-panel-sketch.svg');

  it('produces the two panels at their drawn sizes', () => {
    // Checked against the drawing: a 120x80 panel and a 60x40 panel.
    expect(outcome.parts).toHaveLength(2);
    expect(rowAt(outcome.parts, 120, 80).qty).toBe(1);
    expect(rowAt(outcome.parts, 60, 40).qty).toBe(1);
  });

  it('does not call the CAD y-flip a shear', () => {
    // `matrix(1,0,0,-1,0,200)` is a mirror. It maps rectangles to rectangles
    // perfectly well, so the box stays exact and nothing is oversized.
    expect(kinds(outcome)).not.toContain('sheared-shape');
    expect(outcome.parts.flatMap((part) => part.flags)).toEqual([]);
  });

  it('discards the interior cutout and says why', () => {
    expect(kinds(outcome)).toContain('hole-discarded');
    const hole = outcome.warnings.find((w) => w.kind === 'hole-discarded');
    expect(hole?.count).toBe(1);
    expect(hole?.message).toContain('table saw');
  });
});

// --- The self round-trip --------------------------------------------------

describe('importing our own SVG export', () => {
  /**
   * The strongest test in the file, because the correct answer is known
   * exactly rather than measured. `export/svg.ts` produces complex,
   * tool-independent SVG whose every dimension the exporter chose, and
   * `test/export/svg.test.ts` already asserts this golden is current.
   *
   * The header is `width="2472mm" viewBox="-16 -90.64 2472 1326.64"`, so
   * millimetres per user unit is exactly 1 and the viewBox origin is negative -
   * a case that silently shifts every part if it is not honoured.
   */
  const outcome = (() => {
    const text = readFileSync('test/export/golden/bookshelf-sheet-1.svg', 'utf8');
    const result = importSvg(text);
    if (!result.ok) throw new Error(`round trip failed: ${result.error.kind}`);
    return result;
  })();

  it('recovers a scale of exactly 1mm per unit', () => {
    expect(outcome.scale).toEqual({ kind: 'declared', unit: 'mm', mmPerUnit: 1 });
  });

  it('recovers the part rectangles at their exact placement dimensions', () => {
    // The bookshelf fixture places four 1600x300 sides and four 780x300
    // shelves on this sheet. These are the numbers the exporter drew.
    expect(rowAt(outcome.parts, 1600, 300).qty).toBe(4);
    expect(rowAt(outcome.parts, 780, 300).qty).toBe(4);
  });

  it('recovers the sheet and trim frames, honouring the negative viewBox origin', () => {
    // 2440x1220 stock with 5mm of edge trim, and the full-bleed background at
    // the viewBox's own size. Getting the origin wrong moves these, not resizes
    // them - but their presence at exactly these sizes proves the scale.
    expect(rowAt(outcome.parts, 2440, 1220)).toBeDefined();
    expect(rowAt(outcome.parts, 2430, 1210)).toBeDefined();
    expect(rowAt(outcome.parts, 2472, 1326.64)).toBeDefined();
  });

  it('warns about the dimension text rather than choking on it', () => {
    const text = outcome.warnings.find((w) => w.kind === 'unsupported-element');
    expect(text?.count).toBe(22);
  });

  it('folds the cut lines into one counted warning', () => {
    const degenerate = outcome.warnings.find((w) => w.kind === 'degenerate-shape');
    expect(degenerate?.count).toBe(15);
  });
});

// --- The supported subset -------------------------------------------------

describe('the documented subset', () => {
  function synthetic(name: string): Extract<ImportOutcome, { ok: true }> {
    const outcome = importSvg(readFileSync(`test/files/synthetic/${name}`, 'utf8'));
    if (!outcome.ok) throw new Error(`${name} failed: ${outcome.error.kind}`);
    return outcome;
  }

  it('composes transforms down three levels and keeps the true size', () => {
    // A 100x50 rect drawn at 30 degrees is a 100x50 part, not its 111x93
    // axis-aligned footprint.
    const { parts } = synthetic('nested-transforms.svg');
    expect(parts).toHaveLength(1);
    expect(parts[0]?.width).toBeCloseTo(100, 6);
    expect(parts[0]?.height).toBeCloseTo(50, 6);
    expect(parts[0]?.angle).toBeCloseTo(30, 6);
  });

  it('drops hidden layers, whether hidden by attribute or by inline style', () => {
    const { parts } = synthetic('hidden-layer.svg');
    expect(parts).toHaveLength(1);
    expect(parts[0]?.label).toBe('keep');
  });

  it('resolves use clones into a quantity', () => {
    // An importer that ignores `use` returns one part from a drawing that
    // plainly shows three.
    const { parts } = synthetic('use-clones.svg');
    expect(parts).toHaveLength(1);
    expect(parts[0]?.qty).toBe(3);
    expect(parts[0]?.label).toBe('Shelf A');
  });

  it('survives a use cycle and a dangling reference, reporting both', () => {
    const outcome = synthetic('use-cycle.svg');
    expect(outcome.parts).toHaveLength(1);
    expect(outcome.warnings.find((w) => w.kind === 'use-not-resolved')?.count).toBe(2);
  });

  it('takes one branch of a switch, not every alternative', () => {
    const { parts } = synthetic('switch-alternatives.svg');
    expect(parts).toHaveLength(1);
    expect(parts[0]?.label).toBe('chosen');
  });

  it('flattens arcs to within the tolerance', () => {
    // A 100mm circle written as two arc commands.
    const { parts } = synthetic('arcs.svg');
    expect(parts[0]?.width).toBeCloseTo(100, 1);
    expect(parts[0]?.height).toBeCloseTo(100, 1);
  });

  it('reports a rotationally ambiguous outline at a meaningless angle, by design', () => {
    // A flattened circle has 128 hull edges whose enclosing boxes all tie within
    // 6e-4 of each other on area, so which orientation wins is an artefact of
    // where the flattener placed vertices, not a measurement. The *dimensions*
    // are what matter and they are right; the angle is noise. Pinned here so
    // the next reader knows it is understood rather than overlooked - and so
    // PR 3's preview does not present it as if it meant something.
    const { parts } = synthetic('arcs.svg');
    expect(parts[0]?.angle).toBeGreaterThanOrEqual(0);
    expect(parts[0]?.angle).toBeLessThan(90);
  });

  it('nests a hole inside its own compound path', () => {
    const outcome = synthetic('compound-path.svg');
    expect(outcome.parts).toHaveLength(1);
    expect(outcome.parts[0]?.width).toBeCloseTo(100, 6);
    expect(outcome.warnings.find((w) => w.kind === 'hole-discarded')?.count).toBe(1);
  });

  it('makes two disjoint subpaths of one path into two parts', () => {
    // Common in Illustrator output, where a compound path holds a whole set of
    // panels. Each gets its own indexed label so the table is not all duplicates.
    const { parts } = synthetic('disjoint-subpaths.svg');
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.label)).toEqual(['pair 1', 'pair 2']);
  });

  it('reports an open outline with the size of the gap', () => {
    const outcome = synthetic('open-path.svg');
    expect(outcome.parts).toHaveLength(1);
    const open = outcome.warnings.find((w) => w.kind === 'open-path');
    expect(open?.count).toBe(1);
    // "your path is open by 4.2mm" locates it; "unsupported path" does not.
    expect(open?.message).toContain('4.2mm');
  });

  it('flags a shear as oversized but not a non-uniform scale', () => {
    const outcome = synthetic('shear.svg');
    const skewed = outcome.parts.find((p) => p.label === 'skewed');
    const stretched = outcome.parts.find((p) => p.label === 'stretched');
    expect(skewed?.flags).toContainEqual({ kind: 'sheared' });
    // scale(2,1) maps a rectangle to a rectangle, so the box is still exact.
    expect(stretched?.flags).toEqual([]);
    expect(stretched?.width).toBeCloseTo(100, 6);
    expect(outcome.warnings.find((w) => w.kind === 'sheared-shape')?.count).toBe(1);
  });

  it('takes clipped geometry unclipped, and says the part may be larger', () => {
    const outcome = synthetic('clip-path.svg');
    expect(outcome.parts[0]?.width).toBeCloseTo(100, 6);
    const clipped = outcome.warnings.find((w) => w.kind === 'clipped-geometry');
    expect(clipped?.message).toContain('unclipped');
  });

  it('says a stylesheet was not read rather than parsing CSS', () => {
    const outcome = synthetic('style-block.svg');
    // Both rects arrive, including the one the stylesheet hides. That is the
    // honest outcome of not reading CSS, and the warning is what makes it safe.
    expect(outcome.parts).toHaveLength(2);
    expect(kinds(outcome)).toContain('stylesheet-not-read');
  });

  it('folds construction lines and specks into one degenerate count', () => {
    const outcome = synthetic('degenerate.svg');
    expect(outcome.parts).toHaveLength(1);
    // Two lines, a hairline rect and a 0.8mm dot - one warning, not four.
    expect(outcome.warnings.filter((w) => w.kind === 'degenerate-shape')).toHaveLength(1);
    expect(outcome.warnings.find((w) => w.kind === 'degenerate-shape')?.count).toBe(4);
  });

  it('skips a subtree under a transform it cannot read, rather than assuming identity', () => {
    // Identity is the dangerous answer: the shape still imports, at a
    // believable size, in the wrong place.
    const outcome = synthetic('bad-transform.svg');
    expect(outcome.parts).toHaveLength(1);
    expect(outcome.parts[0]?.label).toBe('fine');
    const bad = outcome.warnings.find((w) => w.kind === 'unparseable-transform');
    expect(bad?.message).toContain('translate(10,0) garbage(3)');
  });

  it('honours a non-zero viewBox origin', () => {
    const { parts } = synthetic('viewbox-origin.svg');
    expect(parts[0]?.width).toBeCloseTo(100, 6);
    expect(parts[0]?.height).toBeCloseTo(50, 6);
  });

  it('fits a mismatched aspect uniformly rather than stretching one axis', () => {
    // 100x100mm of viewport showing a 200x100 viewBox. Taking sx alone happens
    // to be right here; taking sy alone would report a 200x100 part.
    const { parts } = synthetic('mismatched-aspect.svg');
    expect(parts[0]?.width).toBeCloseTo(100, 6);
    expect(parts[0]?.height).toBeCloseTo(50, 6);
  });

  it('still produces parts when no scale can be derived, and says there is none', () => {
    // Relative sizes are informative and the preview shows them; what it will
    // not do is let anything be committed until a scale exists.
    const outcome = synthetic('no-scale.svg');
    expect(outcome.scale).toEqual({ kind: 'none' });
    expect(outcome.parts).toHaveLength(1);
    // drawingWidthMm is meaningless with no scale, but extentWidth survives -
    // it is what the preview's override control divides an entered width by.
    expect(outcome.drawingWidthMm).toBeNull();
    expect(outcome.extentWidth).not.toBeNull();
  });

  it('folds unsupported elements by name, not into one useless total', () => {
    // "8 unsupported elements" throws away the only part a user can act on.
    const outcome = synthetic('text-only.svg');
    expect(outcome.parts).toEqual([]);
    const messages = outcome.warnings.map((w) => w.message);
    expect(messages.some((m) => m.includes('2 <text> elements were'))).toBe(true);
    expect(messages.some((m) => m.includes('1 <image> element was'))).toBe(true);
  });

  it('is not an error to find no parts when there is something to say about why', () => {
    // `emptyDrawing`'s "no shapes were found" is not actionable; "22 text
    // elements were skipped, convert them to paths" is.
    const outcome = importSvg(readFileSync('test/files/synthetic/text-only.svg', 'utf8'));
    expect(outcome.ok).toBe(true);
  });
});

// --- Errors ---------------------------------------------------------------

describe('files that cannot be used at all', () => {
  it('reports an empty drawing when there is nothing to say', () => {
    const outcome = importSvg(readFileSync('test/files/synthetic/empty.svg', 'utf8'));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('empty-drawing');
  });

  it('reports a truncated file', () => {
    const outcome = importSvg('<svg xmlns="http://www.w3.org/2000/svg"><g><rect/>');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('not-xml');
  });

  it('reports a non-SVG XML file', () => {
    const outcome = importSvg('<drawing><line/></drawing>');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('not-svg');
  });

  it('stops at the shape cap rather than hanging the tab', () => {
    // Bare `<rect/>`s, because the cap counts shape *elements met*, not parts
    // produced - a drawing can blow it entirely on geometry that goes nowhere.
    // It also keeps this test cheap: measuring 2001 real rectangles costs four
    // seconds of CI to prove something about a counter.
    const many = '<rect/>'.repeat(MAX_SHAPES + 1);
    const outcome = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" viewBox="0 0 100 100">${many}</svg>`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('too-many-shapes');
  });

  it('accepts a drawing sitting exactly on the cap', () => {
    const many = '<rect width="10" height="10"/>'.repeat(MAX_SHAPES);
    const outcome = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" viewBox="0 0 100 100">${many}</svg>`,
    );
    expect(outcome.ok).toBe(true);
  });
});

// --- Properties -----------------------------------------------------------

describe('properties that must hold for every file', () => {
  const names = [
    'inkscape-shelf-unit.svg',
    'illustrator-drawer-boxes.svg',
    'fusion-panel-sketch.svg',
  ];

  it.each(names)('%s imports identically twice', (name) => {
    // A user who imports, adjusts a sheet size and imports again must not get a
    // different cut list.
    expect(importSvg(load(name))).toEqual(importSvg(load(name)));
  });

  it.each(names)('%s produces parts that pass domain validation', (name) => {
    const parts: Part[] = imported(name).parts.map((part, i) => ({
      id: `p${i}`,
      label: part.label,
      width: part.width,
      height: part.height,
      qty: part.qty,
      materialId: 'm1',
      rotationPolicy: 'free90',
    }));
    const stock: Stock[] = [
      { id: 's1', materialId: 'm1', width: 2440, height: 1220, qty: 10, grainAxis: 'x' },
    ];
    const config: SolverConfig = { kerf: 3, edgeTrim: 5, seed: 1 };
    expect(validateInputs(parts, stock, config)).toEqual([]);
  });

  it.each(names)('%s has every label non-empty and every quantity positive', (name) => {
    for (const part of imported(name).parts) {
      expect(part.label.trim()).not.toBe('');
      expect(part.qty).toBeGreaterThan(0);
      expect(part.width).toBeGreaterThan(0);
      expect(part.height).toBeGreaterThan(0);
    }
  });

  it('applies a scale override end to end', () => {
    // The fix for a 90dpi Inkscape file or an export in the wrong unit.
    const text = load('inkscape-shelf-unit.svg');
    const doubled = importSvg(text, { mmPerUnitOverride: 2 });
    expect(doubled.ok).toBe(true);
    if (!doubled.ok) return;
    expect(doubled.scale).toEqual({ kind: 'user', mmPerUnit: 2 });
    expect(rowAt(doubled.parts, 1600, 600).qty).toBe(2);
  });

  it('parses the largest committed file well inside a frame', () => {
    // §5.8: parsing runs synchronously on the main thread by design, so this is
    // the number that decides whether that stays acceptable. If a real file
    // makes it untenable the answer is a lower cap, not a worker.
    const text = readFileSync('test/export/golden/bookshelf-sheet-1.svg', 'utf8');
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) importSvg(text);
    const each = (performance.now() - started) / 20;
    console.log(`  import of ${(text.length / 1024).toFixed(1)}KB: ${each.toFixed(1)}ms`);
    expect(each).toBeLessThan(250);
  });
});
