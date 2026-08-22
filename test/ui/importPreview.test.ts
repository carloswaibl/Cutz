/**
 * `ImportPreview` and `ImportWarnings`, rendered through `renderToStaticMarkup`
 * with `createElement` - the same plain-Node convention `test/ui/print.test.ts`
 * uses, since neither component owns any interaction logic of its own: every
 * piece of state a user could change arrives as a prop.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Material } from '../../src/domain/types';
import type {
  ImportedPart,
  ImportOutcome,
  ImportWarning,
  ScaleSource,
} from '../../src/import/types';
import {
  ImportPreview,
  initialRows,
  type PreviewFile,
  type PreviewFileState,
} from '../../src/ui/components/import/ImportPreview';

type Outcome = Extract<ImportOutcome, { ok: true }>;

const PLYWOOD: Material = { id: 'mat-1', name: 'Plywood', thickness: 18, hasGrain: true };

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

function readyFile(
  id: string,
  o: Outcome,
  stateOverrides: Partial<Extract<PreviewFileState, { status: 'ready' }>> = {},
  materials: readonly Material[] = [PLYWOOD],
): PreviewFile {
  const thicknessMm = stateOverrides.thicknessMm ?? null;
  return {
    id,
    filename: `${id}.svg`,
    state: {
      status: 'ready',
      kind: 'svg',
      outcome: o,
      thicknessMm,
      rows: initialRows(o, materials, 'mat-1', thicknessMm),
      overrideText: '',
      overrideError: null,
      ...stateOverrides,
    },
  };
}

function render(files: PreviewFile[], propOverrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ImportPreview, {
      files,
      onRowChange: () => {},
      materials: [PLYWOOD],
      rotationPolicy: 'free90',
      onRotationPolicyChange: () => {},
      mode: 'append',
      onModeChange: () => {},
      existingPartCount: 3,
      displayUnit: 'metric-mm',
      fractionDenominator: 1,
      onOverrideChange: () => {},
      onOverrideBlur: () => {},
      canCommit: true,
      onCommit: () => {},
      ...propOverrides,
    }),
  );
}

describe('scale wording', () => {
  it('states a declared scale in words', () => {
    const html = render([readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }))]);
    expect(html).toContain('Declared in the file');
  });

  it('states an assumed-px scale in words, distinctly from a declared one', () => {
    const html = render([readyFile('f1', outcome({ kind: 'assumed-px', mmPerUnit: 25.4 / 96 }))]);
    expect(html).toContain('assumed 96px per inch');
  });

  it('states a user override in words', () => {
    const html = render([readyFile('f1', outcome({ kind: 'user', mmPerUnit: 2 }))]);
    expect(html).toContain('Using the width you entered');
  });

  it('says plainly that no scale could be detected', () => {
    const html = render([readyFile('f1', outcome({ kind: 'none' }))]);
    expect(html).toContain('No scale could be detected');
  });
});

describe('commit gating', () => {
  it('disables the commit button when canCommit is false', () => {
    const html = render(
      [readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }))],
      {
        canCommit: false,
      },
    );
    const button = html.match(/<button[^>]*>Add[\s\S]*?<\/button>/)?.[0];
    expect(button).toContain('disabled=""');
  });

  it('enables the commit button when canCommit is true', () => {
    const html = render(
      [readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }))],
      {
        canCommit: true,
      },
    );
    const button = html.match(/<button[^>]*>Add[\s\S]*?<\/button>/)?.[0];
    expect(button).not.toContain('disabled=""');
  });

  it('shows the no-materials message when there are none to assign', () => {
    const html = render(
      [readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }))],
      {
        materials: [],
      },
    );
    expect(html).toContain('No materials yet');
  });
});

describe('warnings', () => {
  it("renders each file's warnings with its count", () => {
    const warnings: ImportWarning[] = [
      { kind: 'unsupported-element', count: 3, message: '3 <text> elements were skipped.' },
      { kind: 'open-path', count: 1, message: '1 outline is not closed - the gap is 4.2mm.' },
    ];
    const html = render([
      readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }, { warnings })),
    ]);
    expect(html).toContain('2 warnings');
    expect(html).toContain('4 items affected');
    expect(html).toContain('3 &lt;text&gt; elements were skipped.');
    expect(html).toContain('1 outline is not closed - the gap is 4.2mm.');
  });

  it('renders nothing when there are no warnings', () => {
    const html = render([
      readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }, { warnings: [] })),
    ]);
    expect(html).not.toContain('warning');
  });
});

describe('the angle column', () => {
  it('shows the detected angle for a rectangular row', () => {
    const html = render([
      readyFile(
        'f1',
        outcome(
          { kind: 'declared', unit: 'mm', mmPerUnit: 1 },
          { parts: [part({ width: 600, height: 300, angle: 12.5 })] },
        ),
      ),
    ]);
    expect(html).toContain('12.5°');
  });

  it('suppresses a meaningless angle on a near-square row', () => {
    // A 300x300.2 box is square within the grouping tolerance - the flattener
    // artefact §7's PR 2 finding describes, not a real orientation.
    const html = render([
      readyFile(
        'f1',
        outcome(
          { kind: 'declared', unit: 'mm', mmPerUnit: 1 },
          { parts: [part({ width: 300, height: 300.2, angle: 37 })] },
        ),
      ),
    ]);
    expect(html).not.toContain('37.0°');
  });
});

describe('multi-file rendering', () => {
  it('shows each filename when more than one file is in the drop', () => {
    const html = render([
      readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 })),
      readyFile('f2', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 })),
    ]);
    expect(html).toContain('f1.svg');
    expect(html).toContain('f2.svg');
  });

  it('omits the filename heading for a single-file drop', () => {
    const html = render([readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }))]);
    expect(html).not.toContain('f1.svg');
  });

  it('shows an error banner for a file that failed to parse, without hiding the others', () => {
    const html = render([
      { id: 'bad', filename: 'bad.svg', state: { status: 'error', message: 'not an SVG file' } },
      readyFile('good', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 })),
    ]);
    expect(html).toContain('not an SVG file');
    expect(html).toContain('Shelf');
  });
});

describe('the thickness column', () => {
  it('is shown for an STL-sourced file and populated from thicknessMm', () => {
    const o = outcome(
      { kind: 'none' },
      {
        parts: [part({ sourceIds: ['shelf.stl#0'] })],
        drawingWidthMm: null,
        drawingHeightMm: null,
      },
    );
    const html = render([readyFile('f1', o, { kind: 'stl', thicknessMm: { 'shelf.stl#0': 18 } })]);
    expect(html).toContain('Thickness');
    expect(html).toContain('18');
  });

  it('is omitted entirely for an SVG-sourced file', () => {
    const html = render([readyFile('f1', outcome({ kind: 'declared', unit: 'mm', mmPerUnit: 1 }))]);
    expect(html).not.toContain('Thickness');
  });
});
