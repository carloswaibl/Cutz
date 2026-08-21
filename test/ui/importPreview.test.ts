/**
 * `ImportPreview` and `ImportWarnings`, rendered through `renderToStaticMarkup`
 * with `createElement` - the same plain-Node convention `test/ui/print.test.ts`
 * uses, since neither component owns any interaction logic of its own: every
 * piece of state a user could change arrives as a prop.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  ImportedPart,
  ImportOutcome,
  ImportWarning,
  ScaleSource,
} from '../../src/import/types';
import { ImportPreview, initialRows } from '../../src/ui/components/import/ImportPreview';

type Outcome = Extract<ImportOutcome, { ok: true }>;

function part(overrides: Partial<ImportedPart> = {}): ImportedPart {
  return {
    label: 'Shelf',
    width: 600,
    height: 300,
    qty: 1,
    angle: 0,
    flags: [],
    sourceIds: ['shelf-1'],
    ...overrides,
  };
}

function outcome(scale: ScaleSource, overrides: Partial<Outcome> = {}): Outcome {
  return {
    ok: true,
    parts: [part()],
    warnings: [],
    scale,
    drawingWidthMm: scale.kind === 'none' ? null : 600,
    drawingHeightMm: scale.kind === 'none' ? null : 300,
    extentWidth: 600,
    extentHeight: 300,
    ...overrides,
  };
}

function render(o: Outcome, propOverrides: Record<string, unknown> = {}): string {
  const rows = initialRows(o);
  return renderToStaticMarkup(
    createElement(ImportPreview, {
      outcome: o,
      rows,
      onRowChange: () => {},
      materials: [{ id: 'mat-1', name: 'Plywood', thickness: 18, hasGrain: true }],
      materialId: 'mat-1',
      onMaterialChange: () => {},
      rotationPolicy: 'free90',
      onRotationPolicyChange: () => {},
      mode: 'append',
      onModeChange: () => {},
      existingPartCount: 3,
      displayUnit: 'metric-mm',
      fractionDenominator: 1,
      overrideText: '',
      onOverrideChange: () => {},
      onOverrideBlur: () => {},
      overrideError: null,
      onCommit: () => {},
      ...propOverrides,
    }),
  );
}

describe('scale wording', () => {
  it('states a declared scale in words', () => {
    const html = render(outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }));
    expect(html).toContain('Declared in the file');
  });

  it('states an assumed-px scale in words, distinctly from a declared one', () => {
    const html = render(outcome({ kind: 'assumed-px', mmPerUnit: 25.4 / 96 }));
    expect(html).toContain('assumed 96px per inch');
  });

  it('states a user override in words', () => {
    const html = render(outcome({ kind: 'user', mmPerUnit: 2 }));
    expect(html).toContain('Using the width you entered');
  });

  it('says plainly that no scale could be detected', () => {
    const html = render(outcome({ kind: 'none' }));
    expect(html).toContain('No scale could be detected');
  });
});

describe('commit gating', () => {
  it('disables commit when the scale is none and no override has been entered', () => {
    const html = render(outcome({ kind: 'none' }), { overrideText: '' });
    const button = html.match(/<button[^>]*>Add[\s\S]*?<\/button>/)?.[0];
    expect(button).toContain('disabled=""');
  });

  it('enables commit once an override has been typed, even with scale none', () => {
    const html = render(outcome({ kind: 'none' }), { overrideText: '24"' });
    const button = html.match(/<button[^>]*>Add[\s\S]*?<\/button>/)?.[0];
    expect(button).not.toContain('disabled=""');
  });

  it('disables commit and explains when there are no materials to assign', () => {
    const html = render(outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }), { materials: [] });
    const button = html.match(/<button[^>]*>Add[\s\S]*?<\/button>/)?.[0];
    expect(button).toContain('disabled=""');
    expect(html).toContain('No materials yet');
  });
});

describe('warnings', () => {
  it('renders each warning with its count', () => {
    const warnings: ImportWarning[] = [
      { kind: 'unsupported-element', count: 3, message: '3 <text> elements were skipped.' },
      { kind: 'open-path', count: 1, message: '1 outline is not closed - the gap is 4.2mm.' },
    ];
    const html = render(outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }, { warnings }));
    expect(html).toContain('2 warnings');
    expect(html).toContain('4 items affected');
    expect(html).toContain('3 &lt;text&gt; elements were skipped.');
    expect(html).toContain('1 outline is not closed - the gap is 4.2mm.');
  });

  it('renders nothing when there are no warnings', () => {
    const html = render(outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }, { warnings: [] }));
    expect(html).not.toContain('warning');
  });
});

describe('the angle column', () => {
  it('shows the detected angle for a rectangular row', () => {
    const html = render(
      outcome(
        { kind: 'declared', unit: 'mm', mmPerUnit: 1 },
        { parts: [part({ width: 600, height: 300, angle: 12.5 })] },
      ),
    );
    expect(html).toContain('12.5°');
  });

  it('suppresses a meaningless angle on a near-square row', () => {
    // A 300x300.2 box is square within the grouping tolerance - the flattener
    // artefact §7's PR 2 finding describes, not a real orientation.
    const html = render(
      outcome(
        { kind: 'declared', unit: 'mm', mmPerUnit: 1 },
        { parts: [part({ width: 300, height: 300.2, angle: 37 })] },
      ),
    );
    expect(html).not.toContain('37.0°');
  });
});
