import { describe, expect, it } from 'vitest';
import { type Contour, nestContours } from '../../src/import/contours';
import { minAreaBox, type Point } from '../../src/import/geometry';
import {
  checkManifold,
  splitComponents,
  type WeldedMesh,
  weldTriangleSoup,
} from '../../src/import/stl/mesh';
import { parseStlBytes } from '../../src/import/stl/parse';
import { projectTopFace } from '../../src/import/stl/project';
import { detectSlab } from '../../src/import/stl/slab';
import {
  baseWithFusedFinTriangles,
  boxTriangles,
  buildBinaryStl,
  slabTriangles,
  slabWithHoleTriangles,
  type Triangle,
  tetrahedronTriangles,
  translateTriangles,
} from './stlFixtures';

function meshFromTriangles(triangles: readonly Triangle[]): WeldedMesh {
  const bytes = buildBinaryStl(triangles);
  return weldTriangleSoup(parseStlBytes(bytes));
}

function toContour(points: Point[]): Contour {
  return { points, box: minAreaBox(points) };
}

/** Width and height, smaller first, so a test doesn't care which axis a box picked. */
function sortedDims(width: number, height: number): number[] {
  return [width, height].sort((a, b) => a - b);
}

describe('a rectangular slab', () => {
  it('is one manifold component, detected as a slab at the right size', () => {
    const mesh = meshFromTriangles(slabTriangles(600, 300, 18));
    const components = splitComponents(mesh);
    expect(components).toHaveLength(1);

    const component = components[0];
    if (!component) throw new Error('expected a component');
    expect(checkManifold(mesh, component)).toEqual({ manifold: true });

    const slab = detectSlab(mesh, component.triangleIndices);
    expect(slab.ok).toBe(true);
    if (!slab.ok) return;
    expect(slab.thickness).toBeCloseTo(18, 6);

    const loops = projectTopFace(mesh, slab.topTriangleIndices, slab.topNormal);
    expect(loops).toHaveLength(1);
    const nested = nestContours(loops.map(toContour));
    expect(nested.outers).toHaveLength(1);
    expect(nested.holeCount).toBe(0);

    const box = nested.outers[0]?.box;
    expect(box).toBeDefined();
    if (!box) return;
    expect(sortedDims(box.width, box.height)).toEqual([
      expect.closeTo(300, 3),
      expect.closeTo(600, 3),
    ]);
    expect(box.angle).toBeCloseTo(0, 3);
  });
});

describe('a slab with an interior hole', () => {
  it('discards the hole and keeps the panel dimensions', () => {
    const mesh = meshFromTriangles(
      slabWithHoleTriangles(600, 300, 18, { x0: 200, x1: 400, y0: 100, y1: 200 }),
    );
    const components = splitComponents(mesh);
    expect(components).toHaveLength(1);
    const component = components[0];
    if (!component) throw new Error('expected a component');
    expect(checkManifold(mesh, component)).toEqual({ manifold: true });

    const slab = detectSlab(mesh, component.triangleIndices);
    expect(slab.ok).toBe(true);
    if (!slab.ok) return;
    expect(slab.thickness).toBeCloseTo(18, 6);

    const loops = projectTopFace(mesh, slab.topTriangleIndices, slab.topNormal);
    expect(loops).toHaveLength(2); // the outline, and the hole's own boundary

    const nested = nestContours(loops.map(toContour));
    expect(nested.outers).toHaveLength(1);
    expect(nested.holeCount).toBe(1);

    const box = nested.outers[0]?.box;
    expect(box).toBeDefined();
    if (!box) return;
    expect(sortedDims(box.width, box.height)).toEqual([
      expect.closeTo(300, 3),
      expect.closeTo(600, 3),
    ]);
  });
});

describe('two disconnected slabs in one file', () => {
  it('splits into two components, each independently a slab at its own size', () => {
    const a = slabTriangles(600, 300, 18);
    const b = translateTriangles(slabTriangles(400, 200, 18), [2000, 0, 0]);
    const mesh = meshFromTriangles([...a, ...b]);

    const components = splitComponents(mesh);
    expect(components).toHaveLength(2);

    const sizes = components.map((component) => {
      const slab = detectSlab(mesh, component.triangleIndices);
      expect(slab.ok).toBe(true);
      if (!slab.ok) return null;
      const loops = projectTopFace(mesh, slab.topTriangleIndices, slab.topNormal);
      const nested = nestContours(loops.map(toContour));
      const box = nested.outers[0]?.box;
      return box ? sortedDims(Math.round(box.width), Math.round(box.height)) : null;
    });

    expect(sizes).toContainEqual([300, 600]);
    expect(sizes).toContainEqual([200, 400]);
  });
});

describe('a non-manifold mesh', () => {
  it('is rejected rather than guessed through', () => {
    // A watertight box with one wall triangle removed - a genuine hole in the
    // mesh, the same shape a bad boolean operation in a CAD tool leaves.
    const triangles = boxTriangles([0, 0, 0], [100, 100, 10]);
    const mesh = meshFromTriangles(triangles.slice(0, -1));

    const components = splitComponents(mesh);
    expect(components).toHaveLength(1);
    const component = components[0];
    if (!component) throw new Error('expected a component');

    const check = checkManifold(mesh, component);
    expect(check.manifold).toBe(false);
    if (check.manifold) return;
    expect(check.openEdgeCount).toBeGreaterThan(0);
  });
});

describe('a mesh that is not a slab', () => {
  it('rejects a cube, where no antiparallel face pair dominates the surface', () => {
    const mesh = meshFromTriangles(boxTriangles([0, 0, 0], [100, 100, 100]));
    const component = splitComponents(mesh)[0];
    if (!component) throw new Error('expected a component');
    expect(detectSlab(mesh, component.triangleIndices).ok).toBe(false);
  });

  it('rejects a body with a second block fused onto its face, not silently boxed', () => {
    const mesh = meshFromTriangles(baseWithFusedFinTriangles());
    const components = splitComponents(mesh);
    expect(components).toHaveLength(1);
    const component = components[0];
    if (!component) throw new Error('expected a component');
    expect(checkManifold(mesh, component)).toEqual({ manifold: true });
    expect(detectSlab(mesh, component.triangleIndices).ok).toBe(false);
  });

  it('rejects a tetrahedron, which has no antiparallel face pair at all', () => {
    const mesh = meshFromTriangles(tetrahedronTriangles());
    const component = splitComponents(mesh)[0];
    if (!component) throw new Error('expected a component');
    expect(detectSlab(mesh, component.triangleIndices).ok).toBe(false);
  });
});

describe('vertex welding tolerance', () => {
  /**
   * Two triangles that share an edge conceptually - the second's first two
   * corners are the first's first and third corners, jittered by `jitter`.
   * Bounding-box diagonal here is ~141, so `WELD_TOLERANCE_FRACTION` (1e-5)
   * puts the tolerance at ~0.0014.
   */
  function twoTriangles(jitter: number): Triangle[] {
    return [
      [
        [0, 0, 0],
        [100, 0, 0],
        [100, 100, 0],
      ],
      [
        [jitter, 0, 0],
        [100 + jitter, 100, 0],
        [0, 100, 0],
      ],
    ];
  }

  it('welds vertices jittered well within tolerance into one component', () => {
    const mesh = meshFromTriangles(twoTriangles(0.0001));
    expect(splitComponents(mesh)).toHaveLength(1);
  });

  it('leaves vertices jittered well past tolerance as separate components', () => {
    const mesh = meshFromTriangles(twoTriangles(0.05));
    expect(splitComponents(mesh)).toHaveLength(2);
  });
});

describe('determinism', () => {
  it('parses the same buffer to the same result every time', () => {
    const bytes = buildBinaryStl(
      slabWithHoleTriangles(600, 300, 18, { x0: 200, x1: 400, y0: 100, y1: 200 }),
    );

    const run = () => {
      const mesh = weldTriangleSoup(parseStlBytes(bytes));
      const components = splitComponents(mesh);
      const component = components[0];
      if (!component) throw new Error('expected a component');
      const slab = detectSlab(mesh, component.triangleIndices);
      if (!slab.ok) throw new Error('expected a slab');
      const loops = projectTopFace(mesh, slab.topTriangleIndices, slab.topNormal);
      return { mesh, components, thickness: slab.thickness, loops };
    };

    const first = run();
    const second = run();
    expect(Array.from(second.mesh.positions)).toEqual(Array.from(first.mesh.positions));
    expect(Array.from(second.mesh.triangles)).toEqual(Array.from(first.mesh.triangles));
    expect(second.components).toEqual(first.components);
    expect(second.thickness).toEqual(first.thickness);
    expect(second.loops).toEqual(first.loops);
  });
});
