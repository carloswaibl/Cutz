/**
 * Binary STL buffers and simple solid-mesh generators, built in-test.
 *
 * `docs/plan-m5.md` §6 PR 1 calls for testing against synthetic buffers built
 * programmatically rather than files on disk - genuinely sourcing real STL
 * fixtures is PR 2's job, once an importer exists to golden-test against them.
 */

export type Vec3 = readonly [number, number, number];
export type Triangle = readonly [Vec3, Vec3, Vec3];

/** Two triangles filling the quad `p0 -> p1 -> p2 -> p3`, in that boundary order. */
function quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): Triangle[] {
  return [
    [p0, p1, p2],
    [p0, p2, p3],
  ];
}

// --- Axis-aligned faces, named by outward normal -----------------------------
//
// Every face below is written so a box assembled from all six has consistent,
// correct winding throughout (verified by the manifold checks the fixtures
// below assert on themselves) - each helper takes only the ranges it needs so
// the same recipes compose into shapes with faces missing or split, not just
// whole boxes.

function faceBottom(x0: number, x1: number, y0: number, y1: number, z: number): Triangle[] {
  return quad([x0, y0, z], [x0, y1, z], [x1, y1, z], [x1, y0, z]);
}

function faceTop(x0: number, x1: number, y0: number, y1: number, z: number): Triangle[] {
  return quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);
}

function wallY0(x0: number, x1: number, y: number, z0: number, z1: number): Triangle[] {
  return quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]);
}

function wallY1(x0: number, x1: number, y: number, z0: number, z1: number): Triangle[] {
  return quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]);
}

function wallX0(x: number, y0: number, y1: number, z0: number, z1: number): Triangle[] {
  return quad([x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]);
}

function wallX1(x: number, y0: number, y1: number, z0: number, z1: number): Triangle[] {
  return quad([x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]);
}

function boxWalls(min: Vec3, max: Vec3): Triangle[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    ...wallY0(x0, x1, y0, z0, z1),
    ...wallY1(x0, x1, y1, z0, z1),
    ...wallX0(x0, y0, y1, z0, z1),
    ...wallX1(x1, y0, y1, z0, z1),
  ];
}

/** A closed, watertight, axis-aligned box, `min` to `max`. */
export function boxTriangles(min: Vec3, max: Vec3): Triangle[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [...faceBottom(x0, x1, y0, y1, z0), ...faceTop(x0, x1, y0, y1, z1), ...boxWalls(min, max)];
}

/** A flat rectangular panel: `boxTriangles`, named for what it represents here. */
export function slabTriangles(width: number, height: number, thickness: number): Triangle[] {
  return boxTriangles([0, 0, 0], [width, height, thickness]);
}

/**
 * A flat rectangular panel with a rectangular hole punched straight through
 * it. Both faces are subdivided on a 3x3 grid at the hole's own boundary
 * lines so every internal edge is shared by exactly two triangles - a naive
 * "big frame in 4 strips" decomposition produces edges of different lengths
 * meeting head-on (a T-junction), which is not manifold.
 */
export function slabWithHoleTriangles(
  width: number,
  height: number,
  thickness: number,
  hole: { x0: number; x1: number; y0: number; y1: number },
): Triangle[] {
  const xs = [0, hole.x0, hole.x1, width];
  const ys = [0, hole.y0, hole.y1, height];
  const triangles: Triangle[] = [];
  for (let ix = 0; ix < 3; ix += 1) {
    for (let iy = 0; iy < 3; iy += 1) {
      if (ix === 1 && iy === 1) continue; // the hole itself
      const x0 = xs[ix];
      const x1 = xs[ix + 1];
      const y0 = ys[iy];
      const y1 = ys[iy + 1];
      if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) continue;
      triangles.push(...faceBottom(x0, x1, y0, y1, 0));
      triangles.push(...faceTop(x0, x1, y0, y1, thickness));
    }
  }
  // The outer wall must be split at the same grid lines as the top/bottom
  // faces above - a single edge spanning the whole side would meet three
  // separately-subdivided cell edges head-on, a T-junction that leaves every
  // edge involved shared by other than exactly two triangles.
  for (let ix = 0; ix < 3; ix += 1) {
    const x0 = xs[ix];
    const x1 = xs[ix + 1];
    if (x0 === undefined || x1 === undefined) continue;
    triangles.push(...wallY0(x0, x1, 0, 0, thickness));
    triangles.push(...wallY1(x0, x1, height, 0, thickness));
  }
  for (let iy = 0; iy < 3; iy += 1) {
    const y0 = ys[iy];
    const y1 = ys[iy + 1];
    if (y0 === undefined || y1 === undefined) continue;
    triangles.push(...wallX0(0, y0, y1, 0, thickness));
    triangles.push(...wallX1(width, y0, y1, 0, thickness));
  }
  triangles.push(...boxWalls([hole.x0, hole.y0, 0], [hole.x1, hole.y1, thickness]));
  return triangles;
}

/**
 * A thin base slab with a second, tall block fused onto part of its top face
 * - a stand-in for "a second body fused into the same connected component"
 * (`docs/plan-m5.md` §4.4 step 4), the shape that no single antiparallel
 * pair's area-and-equality checks explain away. The fin spans the base's full
 * depth on one axis so no grid subdivision is needed to keep every shared
 * edge manifold - only the base's near/far walls split at the fin's edge.
 */
export function baseWithFusedFinTriangles(): Triangle[] {
  const baseX = 100;
  const baseY = 100;
  const baseZ = 10;
  const finX = 40;
  const finZ = 90;
  return [
    // Split at `finX` to match the walls below, which must split there too -
    // the fin continues upward for x < finX but the wall simply ends at
    // baseZ for x > finX, and a face's edges must match whatever it borders.
    ...faceBottom(0, finX, 0, baseY, 0),
    ...faceBottom(finX, baseX, 0, baseY, 0),
    ...faceTop(finX, baseX, 0, baseY, baseZ), // base top, notch left for the fin
    ...wallY0(0, finX, 0, 0, baseZ),
    ...wallY0(finX, baseX, 0, 0, baseZ),
    ...wallY1(0, finX, baseY, 0, baseZ),
    ...wallY1(finX, baseX, baseY, 0, baseZ),
    ...wallX0(0, 0, baseY, 0, baseZ),
    ...wallX1(baseX, 0, baseY, 0, baseZ),
    ...faceTop(0, finX, 0, baseY, finZ), // fin top
    ...wallY0(0, finX, 0, baseZ, finZ),
    ...wallY1(0, finX, baseY, baseZ, finZ),
    ...wallX0(0, 0, baseY, baseZ, finZ),
    ...wallX1(finX, 0, baseY, baseZ, finZ),
  ];
}

/** A regular-ish tetrahedron: four faces, no two of which are ever antiparallel. */
export function tetrahedronTriangles(scale = 100): Triangle[] {
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [scale, 0, 0];
  const c: Vec3 = [scale / 2, scale, 0];
  const d: Vec3 = [scale / 2, scale / 3, scale];
  return [
    [a, c, b],
    [a, b, d],
    [b, c, d],
    [c, a, d],
  ];
}

/** Translate every vertex of a triangle list by `offset`. */
export function translateTriangles(triangles: readonly Triangle[], offset: Vec3): Triangle[] {
  const [dx, dy, dz] = offset;
  return triangles.map(
    (triangle): Triangle =>
      triangle.map(([x, y, z]): Vec3 => [x + dx, y + dy, z + dz]) as unknown as Triangle,
  );
}

// --- Binary STL encoding -------------------------------------------------------

/**
 * Encode a triangle soup as a binary STL buffer.
 *
 * The stored per-triangle normal is written as zero throughout: `parse.ts`
 * deliberately never reads it, computing face normals from vertex positions
 * instead (a malformed export can carry a garbage stored normal), so a real
 * value here would only be untested dead weight.
 */
export function buildBinaryStl(triangles: readonly Triangle[]): ArrayBuffer {
  const headerSize = 80;
  const triangleRecordSize = 50; // 12 (normal) + 36 (3 vertices) + 2 (attribute byte count)
  const buffer = new ArrayBuffer(headerSize + 4 + triangles.length * triangleRecordSize);
  const view = new DataView(buffer);
  view.setUint32(headerSize, triangles.length, true);

  let offset = headerSize + 4;
  for (const triangle of triangles) {
    offset += 12; // stored normal, left zeroed
    for (const vertex of triangle) {
      for (const component of vertex) {
        view.setFloat32(offset, component, true);
        offset += 4;
      }
    }
    offset += 2; // attribute byte count
  }
  return buffer;
}
