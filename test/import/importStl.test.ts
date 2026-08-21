import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Part, SolverConfig, Stock } from '../../src/domain/types';
import { validateInputs } from '../../src/domain/validate';
import { MAX_FILE_BYTES } from '../../src/import/errors';
import { importStl } from '../../src/import/stl';
import type { ImportOutcome } from '../../src/import/types';
import {
  baseWithFusedFinTriangles,
  boxTriangles,
  buildBinaryStl,
  slabTriangles,
  slabWithHoleTriangles,
  translateTriangles,
} from './stlFixtures';

function ok(outcome: ImportOutcome): Extract<ImportOutcome, { ok: true }> {
  if (!outcome.ok)
    throw new Error(`import failed: ${outcome.error.kind} - ${outcome.error.message}`);
  return outcome;
}

function loadStl(name: string): ArrayBuffer {
  const buf = readFileSync(`test/files/${name}`);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('a rectangular slab', () => {
  it('imports as one part at its true size, with a label from the filename', () => {
    const bytes = buildBinaryStl(slabTriangles(600, 300, 18));
    const outcome = ok(importStl(bytes, 'shelf_side.stl'));

    expect(outcome.parts).toHaveLength(1);
    expect(outcome.warnings).toHaveLength(0);
    expect(outcome.scale).toEqual({ kind: 'none' });
    expect(outcome.drawingWidthMm).toBeNull();
    expect(outcome.drawingHeightMm).toBeNull();

    const part = outcome.parts[0];
    if (!part) throw new Error('expected a part');
    expect(part.label).toBe('shelf side');
    expect(part.qty).toBe(1);
    expect([part.width, part.height].sort((a, b) => a - b)).toEqual([
      expect.closeTo(300, 3),
      expect.closeTo(600, 3),
    ]);
    expect(outcome.extentWidth).toBeCloseTo(part.width, 3);
    expect(outcome.extentHeight).toBeCloseTo(part.height, 3);
  });
});

describe('a slab with an interior hole', () => {
  it('discards the hole, keeps the panel size, and warns once', () => {
    const bytes = buildBinaryStl(
      slabWithHoleTriangles(600, 300, 18, { x0: 200, x1: 400, y0: 100, y1: 200 }),
    );
    const outcome = ok(importStl(bytes, 'panel.stl'));

    expect(outcome.parts).toHaveLength(1);
    expect(outcome.warnings.map((w) => w.kind)).toEqual(['hole-discarded']);
    const part = outcome.parts[0];
    if (!part) throw new Error('expected a part');
    expect([part.width, part.height].sort((a, b) => a - b)).toEqual([
      expect.closeTo(300, 3),
      expect.closeTo(600, 3),
    ]);
  });
});

describe('two disconnected slabs in one file', () => {
  it('produces two rows, each independently labeled and sized', () => {
    const a = slabTriangles(600, 300, 18);
    const b = translateTriangles(slabTriangles(400, 200, 18), [2000, 0, 0]);
    const bytes = buildBinaryStl([...a, ...b]);
    const outcome = ok(importStl(bytes, 'two-shelves.stl'));

    expect(outcome.parts).toHaveLength(2);
    expect(outcome.warnings).toHaveLength(0);
    const labels = outcome.parts.map((p) => p.label).sort();
    expect(labels).toEqual(['two shelves 1', 'two shelves 2']);

    const sizes = outcome.parts
      .map((p) => [p.width, p.height].sort((x, y) => x - y).map((n) => Math.round(n)))
      .sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
    expect(sizes).toEqual([
      [200, 400],
      [300, 600],
    ]);

    // The largest accepted component's own extent, not the smaller one's -
    // width/height assignment depends on which hull edge the box search
    // picked, so compare the sorted pair rather than a specific axis.
    const extent = [outcome.extentWidth, outcome.extentHeight].sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(extent[0]).toBeCloseTo(300, 3);
    expect(extent[1]).toBeCloseTo(600, 3);
  });
});

describe('real files from ImageToStl.com', () => {
  /**
   * Genuine binary STL exports, not reproductions - each an irregular
   * silhouette extruded to a uniform 5-unit thickness, exported by a real
   * tool (ImageToStl.com, which converts a 2D image into a flat extruded
   * mesh). No intended real-world size accompanies them, so this golden test
   * asserts the importer reproduces the exact width/height/angle
   * independently computed from each file's own raw-unit geometry (a plain
   * script reading the binary triangle data directly), rather than claiming
   * any particular millimetre scale - `docs/plan-m5.md` §4.7's "always ask"
   * rule means no scale exists to check against until a user supplies one in
   * the preview (PR 3). The load-bearing thing this proves: a real mesh with
   * thousands of triangles and an irregular, rotated outline - not a
   * hand-modelled cube - clears manifold checking and slab detection cleanly,
   * and the minimum-area box picks up its true rotated footprint rather than
   * an inflated axis-aligned one.
   */
  const cases = [
    { file: 'imagetostl-part-1.stl', width: 160.39, height: 40.37, angle: 70.49 },
    { file: 'imagetostl-part-2.stl', width: 131.09, height: 135.48, angle: 78.28 },
    { file: 'imagetostl-part-3.stl', width: 181.13, height: 51.82, angle: 0 },
  ];

  it.each(cases)(
    '$file imports as one clean slab at its true oriented size',
    ({ file, width, height, angle }) => {
      const outcome = ok(importStl(loadStl(file), file));
      expect(outcome.parts).toHaveLength(1);
      expect(outcome.warnings).toHaveLength(0);

      const part = outcome.parts[0];
      if (!part) throw new Error('expected a part');
      expect(part.width).toBeCloseTo(width, 1);
      expect(part.height).toBeCloseTo(height, 1);
      expect(part.angle).toBeCloseTo(angle, 1);
    },
  );
});

describe('a non-manifold mesh', () => {
  it('is rejected with a specific warning, not silently boxed', () => {
    const triangles = boxTriangles([0, 0, 0], [100, 100, 10]);
    const bytes = buildBinaryStl(triangles.slice(0, -1));
    const outcome = ok(importStl(bytes, 'broken.stl'));

    expect(outcome.parts).toHaveLength(0);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]?.kind).toBe('non-manifold-mesh');
    expect(outcome.warnings[0]?.message).toContain('broken.stl');
  });
});

describe('a mesh that is not a slab', () => {
  it('rejects a cube with a specific warning', () => {
    const bytes = buildBinaryStl(boxTriangles([0, 0, 0], [100, 100, 100]));
    const outcome = ok(importStl(bytes, 'cube.stl'));

    expect(outcome.parts).toHaveLength(0);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]?.kind).toBe('not-a-slab');
    expect(outcome.warnings[0]?.message).toContain('cube.stl');
  });

  it('rejects a body with a second block fused onto its face', () => {
    const bytes = buildBinaryStl(baseWithFusedFinTriangles());
    const outcome = ok(importStl(bytes, 'bracket.stl'));

    expect(outcome.parts).toHaveLength(0);
    expect(outcome.warnings.map((w) => w.kind)).toEqual(['not-a-slab']);
  });

  it('excludes the rejected component while accepted components in the same file still import', () => {
    const rejected = boxTriangles([0, 0, 0], [100, 100, 100]);
    const accepted = translateTriangles(slabTriangles(600, 300, 18), [1000, 0, 0]);
    const bytes = buildBinaryStl([...rejected, ...accepted]);
    const outcome = ok(importStl(bytes, 'mixed.stl'));

    expect(outcome.parts).toHaveLength(1);
    expect(outcome.warnings.map((w) => w.kind)).toEqual(['not-a-slab']);
    const part = outcome.parts[0];
    if (!part) throw new Error('expected a part');
    expect([part.width, part.height].sort((a, b) => a - b)).toEqual([
      expect.closeTo(300, 3),
      expect.closeTo(600, 3),
    ]);
  });
});

describe('files that cannot be used at all', () => {
  it('rejects a file over the size cap', () => {
    const bytes = new ArrayBuffer(MAX_FILE_BYTES + 1);
    const outcome = importStl(bytes, 'huge.stl');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('file-too-large');
  });

  it('rejects a file that is not readable as STL at all', () => {
    const bytes = new TextEncoder().encode('this is not an stl file, just garbage text').buffer;
    const outcome = importStl(bytes, 'garbage.stl');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('not-stl');
  });
});

describe('properties that must hold for every accepted file', () => {
  const files = [
    { name: 'a rectangular slab', bytes: () => buildBinaryStl(slabTriangles(600, 300, 18)) },
    {
      name: 'a slab with a hole',
      bytes: () =>
        buildBinaryStl(slabWithHoleTriangles(600, 300, 18, { x0: 200, x1: 400, y0: 100, y1: 200 })),
    },
    {
      name: 'two disconnected slabs',
      bytes: () =>
        buildBinaryStl([
          ...slabTriangles(600, 300, 18),
          ...translateTriangles(slabTriangles(400, 200, 18), [2000, 0, 0]),
        ]),
    },
  ];

  it.each(files)('$name produces parts that pass domain validation', ({ bytes }) => {
    const outcome = ok(importStl(bytes(), 'fixture.stl'));
    const parts: Part[] = outcome.parts.map((part, i) => ({
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

  it('parses the largest committed file well inside a frame', () => {
    // imagetostl-part-2.stl is the largest committed STL - 953KB, ~19,000
    // triangles - matching `importSvg.test.ts`'s discipline of measuring
    // against the largest real file rather than a synthetic one. The frame is
    // looser than SVG's 250ms: an image-traced silhouette has ~1900x the
    // triangle count of a hand-modelled woodworking panel (this app's actual
    // target size, `CLAUDE.md` constraint 4), so this file is a stress case
    // for mesh math, not the typical one - and per-triangle Vector3 work in
    // `slab.ts`/`project.ts` runs measurably slower under the rest of the
    // suite's CPU contention than in isolation.
    const bytes = loadStl('imagetostl-part-2.stl');
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) importStl(bytes, 'imagetostl-part-2.stl');
    const each = (performance.now() - started) / 20;
    console.log(`  import of ${(bytes.byteLength / 1024).toFixed(1)}KB: ${each.toFixed(1)}ms`);
    expect(each).toBeLessThan(600);
  });
});
