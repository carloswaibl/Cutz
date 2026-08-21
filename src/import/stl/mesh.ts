/**
 * A triangle soup to a welded, indexed mesh, split into connected components,
 * each checked for being watertight.
 *
 * Raw STL triangles share no vertex indices - every triangle stores its own
 * three corners as independently-rounded floats, so a vertex six triangles
 * actually share in the original model appears as six near-identical points
 * in the file. Welding is what makes "these two triangles share an edge" a
 * question with an answer at all; without it, every triangle looks like its
 * own disconnected component.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TriangleSoup } from './parse';

/** A welded, indexed mesh: one entry per unique vertex, three indices per triangle. */
export interface WeldedMesh {
  /** Unique vertex positions, in the file's raw (still-unscaled) units. length = vertexCount * 3. */
  positions: Float32Array;
  /** Vertex indices into `positions`, three per triangle. length = triangleCount * 3. */
  triangles: Uint32Array;
}

/**
 * How much of the mesh's own bounding-box diagonal two vertices may differ by
 * and still weld into one.
 *
 * Relative, not absolute millimetres: at this stage the file's real-world
 * scale is unknown (`docs/plan-m5.md` §4.2) - a mesh modelled in metres and one
 * modelled in tenths of an inch need the same *proportional* tolerance, not
 * the same number.
 */
export const WELD_TOLERANCE_FRACTION = 1e-5;

/**
 * Weld coincident vertices and return an indexed mesh.
 *
 * A wrapper around three's own `mergeVertices`, which already implements the
 * hash-and-truncate welding this milestone would otherwise have to hand-roll -
 * `docs/plan-m5.md` §8 decision 1 chose `three` for exactly this kind of
 * byte/vertex-level work.
 */
export function weldTriangleSoup(
  soup: TriangleSoup,
  toleranceFraction: number = WELD_TOLERANCE_FRACTION,
): WeldedMesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(soup.positions, 3));

  const diagonal = boundingDiagonal(soup.positions);
  const tolerance = diagonal > 0 ? diagonal * toleranceFraction : Number.EPSILON;

  const welded = mergeVertices(geometry, tolerance) as BufferGeometry;
  const index = welded.getIndex();
  const position = welded.getAttribute('position');
  if (!index) {
    // mergeVertices always returns an indexed geometry; this is unreachable
    // and guards the type checker rather than a real failure mode.
    throw new Error('expected an indexed geometry after welding');
  }

  return {
    positions: position.array as Float32Array,
    triangles: Uint32Array.from(index.array as ArrayLike<number>),
  };
}

function boundingDiagonal(positions: Float32Array): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x === undefined || y === undefined || z === undefined) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

// --- Edges ------------------------------------------------------------------

/**
 * An unordered edge as a stable map key. `mesh.ts`, `slab.ts` and
 * `project.ts` all key edge tallies by this - the same identity everywhere,
 * regardless of which of a triangle's three corners happens to name it first.
 */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * A triangle's three edges, directed by the triangle's own winding order.
 *
 * Direction matters to `project.ts`'s boundary-loop walk, which chains a
 * region's boundary edges tip-to-tail; it is irrelevant to a plain edge-count
 * tally, which only cares about the unordered key.
 */
export function triangleEdges(mesh: WeldedMesh, triangle: number): [number, number][] {
  const base = triangle * 3;
  const i0 = mesh.triangles[base];
  const i1 = mesh.triangles[base + 1];
  const i2 = mesh.triangles[base + 2];
  if (i0 === undefined || i1 === undefined || i2 === undefined) return [];
  return [
    [i0, i1],
    [i1, i2],
    [i2, i0],
  ];
}

// --- Connected components ----------------------------------------------------

export interface MeshComponent {
  /** Triangle indices into the parent `WeldedMesh.triangles`, ascending. */
  triangleIndices: number[];
}

/**
 * Split a welded mesh into its connected components by edge adjacency.
 *
 * Two triangles are adjacent when they share an edge - any edge, including
 * one used by three or more triangles, which is itself the non-manifold case
 * `checkManifold` reports on a per-component basis afterward. A file with
 * three named `solid` blocks and a file with three disconnected bodies in one
 * nameless `solid` produce the same components here (`docs/plan-m5.md` §4.1) -
 * this split is the only place body separation actually happens.
 */
export function splitComponents(mesh: WeldedMesh): MeshComponent[] {
  const triangleCount = mesh.triangles.length / 3;
  const adjacency: number[][] = Array.from({ length: triangleCount }, () => []);

  const trianglesByEdge = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t += 1) {
    for (const [a, b] of triangleEdges(mesh, t)) {
      const key = edgeKey(a, b);
      const list = trianglesByEdge.get(key);
      if (list) list.push(t);
      else trianglesByEdge.set(key, [t]);
    }
  }
  for (const triList of trianglesByEdge.values()) {
    for (let i = 0; i < triList.length; i += 1) {
      for (let j = i + 1; j < triList.length; j += 1) {
        const ti = triList[i];
        const tj = triList[j];
        if (ti === undefined || tj === undefined) continue;
        adjacency[ti]?.push(tj);
        adjacency[tj]?.push(ti);
      }
    }
  }

  const visited = new Uint8Array(triangleCount);
  const components: MeshComponent[] = [];
  for (let start = 0; start < triangleCount; start += 1) {
    if (visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    const triangleIndices: number[] = [];
    while (stack.length > 0) {
      const t = stack.pop();
      if (t === undefined) continue;
      triangleIndices.push(t);
      for (const neighbor of adjacency[t] ?? []) {
        if (visited[neighbor]) continue;
        visited[neighbor] = 1;
        stack.push(neighbor);
      }
    }
    // Sorted so the result is the same regardless of stack-traversal order -
    // membership is structural and deterministic already, but the discovery
    // order within a component is not, and a test comparing component
    // contents should not have to sort first.
    triangleIndices.sort((a, b) => a - b);
    components.push({ triangleIndices });
  }
  return components;
}

// --- Manifold check -----------------------------------------------------------

export type ManifoldCheck =
  | { manifold: true }
  /** A genuine hole in the mesh (`openEdgeCount`) or duplicated/self-intersecting geometry (`overusedEdgeCount`). */
  | { manifold: false; openEdgeCount: number; overusedEdgeCount: number };

/**
 * Every edge of a closed, watertight solid belongs to exactly two triangles -
 * one on each side. An edge belonging to one is a boundary the model never
 * closed; one belonging to three or more is self-intersecting or duplicated
 * geometry. Both are rejected rather than guessed through
 * (`docs/plan-m5.md` §4.3) - a bad boolean operation in the source CAD tool is
 * exactly what this catches.
 */
export function checkManifold(mesh: WeldedMesh, component: MeshComponent): ManifoldCheck {
  const counts = new Map<string, number>();
  for (const t of component.triangleIndices) {
    for (const [a, b] of triangleEdges(mesh, t)) {
      const key = edgeKey(a, b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  let openEdgeCount = 0;
  let overusedEdgeCount = 0;
  for (const count of counts.values()) {
    if (count === 1) openEdgeCount += 1;
    else if (count > 2) overusedEdgeCount += 1;
  }

  if (openEdgeCount === 0 && overusedEdgeCount === 0) return { manifold: true };
  return { manifold: false, openEdgeCount, overusedEdgeCount };
}
