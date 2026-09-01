/**
 * A slab's top face to 2D point loops.
 *
 * With the top plane and its triangles known, this is the last STL-specific
 * step: build an axis pair inside that plane, walk the top region's boundary,
 * and project each boundary loop's vertices into it. What comes out is
 * `Point[][]` - one loop per outer outline or interior hole, unclassified -
 * which is exactly the shape `nestContours` (`../contours.ts`) and
 * `minAreaBox` (`../geometry.ts`) already consume for SVG. Nothing past this
 * file is STL-specific (`docs/plan-m5.md` §4.6).
 */

import { Vector3 } from 'three';
import type { Point } from '../../domain/types';
import { edgeKey, triangleEdges, type WeldedMesh } from './mesh';

function vertexAt(mesh: WeldedMesh, index: number): Vector3 {
  const base = index * 3;
  return new Vector3(mesh.positions[base], mesh.positions[base + 1], mesh.positions[base + 2]);
}

/**
 * Find the closed boundary loops of a triangle subset within its parent
 * mesh: vertices where the subset's edge stops being shared by two of the
 * subset's own triangles.
 *
 * Scoped the same way `mesh.ts`'s `checkManifold` finds a whole component's
 * boundary, but counting only edges of triangles in `subsetTriangleIndices` -
 * an edge shared with a wall triangle outside the subset counts once, the
 * same as a genuinely open edge would, because both mean "the subset stops
 * here." Direction is taken from whichever subset triangle owns the edge, so
 * loops chain tip-to-tail rather than needing a separate ordering pass.
 */
function extractBoundaryLoops(
  mesh: WeldedMesh,
  subsetTriangleIndices: readonly number[],
): number[][] {
  const undirectedCount = new Map<string, number>();
  const directedForKey = new Map<string, [number, number]>();

  for (const t of subsetTriangleIndices) {
    for (const [a, b] of triangleEdges(mesh, t)) {
      const key = edgeKey(a, b);
      undirectedCount.set(key, (undirectedCount.get(key) ?? 0) + 1);
      directedForKey.set(key, [a, b]);
    }
  }

  const next = new Map<number, number>();
  for (const [key, count] of undirectedCount) {
    if (count !== 1) continue;
    const directed = directedForKey.get(key);
    if (!directed) continue;
    next.set(directed[0], directed[1]);
  }

  const loops: number[][] = [];
  const consumed = new Set<number>();
  for (const start of next.keys()) {
    if (consumed.has(start)) continue;
    const loop: number[] = [];
    let current = start;
    let closed = false;
    // A malformed boundary (a branch point, or a chain that never returns to
    // `start`) cannot happen for a genuinely manifold subset - this cap just
    // stops a defensive infinite loop rather than modelling a real case.
    for (let steps = 0; steps <= next.size; steps += 1) {
      loop.push(current);
      consumed.add(current);
      const nextVertex = next.get(current);
      if (nextVertex === undefined) break;
      current = nextVertex;
      if (current === start) {
        closed = true;
        break;
      }
    }
    if (closed && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * An orthonormal basis inside the top plane: one axis along a real mesh edge
 * (so it lines up with whatever the file's own geometry is doing, rather than
 * an arbitrary world axis), the other its cross product with the plane
 * normal.
 */
function buildBasis(
  mesh: WeldedMesh,
  topTriangleIndices: readonly number[],
  normal: Vector3,
): { u: Vector3; v: Vector3 } {
  const first = topTriangleIndices[0];
  const edge = first === undefined ? undefined : triangleEdges(mesh, first)[0];
  if (!edge) {
    // No triangle to take an edge from - only reachable if `topTriangleIndices`
    // is empty, which `detectSlab` never returns for an `ok: true` result.
    return { u: new Vector3(1, 0, 0), v: new Vector3(0, 1, 0) };
  }
  const [a, b] = edge;
  const raw = vertexAt(mesh, b).sub(vertexAt(mesh, a));
  const u = raw.sub(normal.clone().multiplyScalar(raw.dot(normal))).normalize();
  const v = normal.clone().cross(u).normalize();
  return { u, v };
}

/**
 * Project a slab's top-face boundary loops into 2D.
 *
 * The origin is an arbitrary point in the plane (the first boundary vertex
 * found); translation does not change a loop's shape, area, or the
 * minimum-area box `minAreaBox` fits around it afterward.
 */
export function projectTopFace(
  mesh: WeldedMesh,
  topTriangleIndices: readonly number[],
  topNormal: Vector3,
): Point[][] {
  const loops = extractBoundaryLoops(mesh, topTriangleIndices);
  if (loops.length === 0) return [];

  const { u, v } = buildBasis(mesh, topTriangleIndices, topNormal);
  const firstVertex = loops[0]?.[0];
  const origin = firstVertex === undefined ? new Vector3() : vertexAt(mesh, firstVertex);

  return loops.map((loop) =>
    loop.map((vertexIndex): Point => {
      const p = vertexAt(mesh, vertexIndex).sub(origin);
      return { x: p.dot(u), y: p.dot(v) };
    }),
  );
}
