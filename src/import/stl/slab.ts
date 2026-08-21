/**
 * The slab-or-reject decision.
 *
 * The actual hard part of the milestone (`docs/plan-m5.md` §4.4), and the
 * reason `CLAUDE.md` constraint 5 - "if a mesh isn't a slab, reject it with a
 * clear message" - is its own explicit rule. A woodworking part is a flat
 * panel: two large, parallel, opposite-facing faces (top and bottom) joined by
 * a thin ribbon of edge ("wall") geometry. An L-bracket, a box, or a cabinet
 * carcass modelled as one body is not that shape, and none of them may become
 * a wrong-shaped rectangle.
 *
 * The alternative considered and rejected: take the mesh's bounding box and
 * call its two largest opposite faces "the panel." That would accept an
 * L-bracket's box (six real faces, none of which is the part) as a flat
 * rectangle - exactly the failure this file exists to prevent.
 */

import { Vector3 } from 'three';
import type { WeldedMesh } from './mesh';

// --- Tolerances ---------------------------------------------------------------

/**
 * How far two triangle normals may point apart, in degrees, and still count
 * as "the same flat region." Real CAD tessellation of one flat face produces
 * triangles whose normals agree to within float precision; this only needs to
 * be loose enough to absorb export noise, not to discover approximately-flat
 * curved surfaces.
 */
const NORMAL_CLUSTER_ANGLE_DEG = 2;
const NORMAL_CLUSTER_COS_THRESHOLD = Math.cos((NORMAL_CLUSTER_ANGLE_DEG * Math.PI) / 180);

/**
 * How far a triangle's centroid may sit off a cluster's plane, as a fraction
 * of the component's bounding-box diagonal, and still belong to that cluster.
 * Relative for the same reason `mesh.ts`'s weld tolerance is: the real-world
 * scale is not known yet.
 */
const PLANAR_TOLERANCE_FRACTION = 1e-4;

/**
 * How close to exactly opposite (dot product -1) two clusters' normals must
 * be to be considered a candidate top/bottom pair.
 */
const ANTIPARALLEL_COS_THRESHOLD = -0.999;

/** How close in area the top and bottom clusters must be, as a fraction of the larger. */
const AREA_MISMATCH_TOLERANCE = 0.05;

/**
 * How far from perpendicular (dot product 0) a non-top/bottom triangle's
 * normal may be and still count as "wall" geometry, rather than unaccounted
 * surface belonging to some other shape entirely.
 */
const WALL_PERPENDICULAR_DOT_THRESHOLD = 0.2;

/**
 * The minimum fraction of a component's total surface area the top and
 * bottom clusters, together, must account for on their own - before any wall
 * triangle is even considered.
 *
 * This is what actually rejects a box or a cube, which the wall-perpendicularity
 * and area-accounting checks alone do not: a cube's opposite faces are
 * perfectly antiparallel, coplanar, and equal in area, and its four remaining
 * faces genuinely are perpendicular to that axis - by those checks alone a
 * cube reads as a very thick "slab." What a cube lacks is the one thing that
 * makes a panel a panel: two faces that dominate the surface because
 * everything between them is thin. A real panel's top and bottom are the
 * overwhelming majority of its area; a cube's are one third.
 */
const MIN_TOP_BOTTOM_AREA_FRACTION = 0.6;

/** How much of a component's total surface area may go unaccounted-for after walls are counted. */
const MAX_UNACCOUNTED_AREA_FRACTION = 0.02;

// --- Result -------------------------------------------------------------------

export type SlabDetection =
  | {
      ok: true;
      /** Perpendicular distance between the top and bottom planes, in the mesh's raw units. */
      thickness: number;
      /** Unit normal of the chosen top face. */
      topNormal: Vector3;
      topTriangleIndices: number[];
      bottomTriangleIndices: number[];
    }
  | {
      ok: false;
      reason: 'no-planar-faces' | 'unequal-faces' | 'unaccounted-geometry';
    };

interface TriangleGeometry {
  /** Unit normal, or the zero vector for a degenerate (zero-area) triangle. */
  normal: Vector3;
  area: number;
  centroid: Vector3;
}

function vertexAt(mesh: WeldedMesh, index: number): Vector3 {
  const base = index * 3;
  return new Vector3(mesh.positions[base], mesh.positions[base + 1], mesh.positions[base + 2]);
}

function triangleGeometry(mesh: WeldedMesh, triangle: number): TriangleGeometry {
  const base = triangle * 3;
  const a = vertexAt(mesh, mesh.triangles[base] ?? 0);
  const b = vertexAt(mesh, mesh.triangles[base + 1] ?? 0);
  const c = vertexAt(mesh, mesh.triangles[base + 2] ?? 0);
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const cross = ab.clone().cross(ac);
  const area = cross.length() / 2;
  const normal = area > 0 ? cross.clone().normalize() : cross;
  const centroid = a
    .clone()
    .add(b)
    .add(c)
    .multiplyScalar(1 / 3);
  return { normal, area, centroid };
}

function componentDiagonal(mesh: WeldedMesh, triangleIndices: readonly number[]): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const t of triangleIndices) {
    const base = t * 3;
    for (const vertexIndex of [
      mesh.triangles[base],
      mesh.triangles[base + 1],
      mesh.triangles[base + 2],
    ]) {
      if (vertexIndex === undefined) continue;
      const v = vertexAt(mesh, vertexIndex);
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

// --- Clustering -----------------------------------------------------------

interface FaceCluster {
  /** The seed triangle's normal - kept fixed rather than averaged, so membership doesn't drift as triangles are added. */
  normal: Vector3;
  /** Signed distance of the seed plane from the origin, along `normal`. */
  planeOffset: number;
  triangleIndices: number[];
  area: number;
}

/**
 * Group a component's triangles into candidate flat regions: same normal
 * direction *and* coplanar, within tolerance (`docs/plan-m5.md` §4.4 step 1).
 * Greedy and order-dependent by construction - deterministic for a fixed
 * input, which is all `checkManifold`'s and this pipeline's determinism
 * guarantee requires.
 */
function clusterFaces(
  mesh: WeldedMesh,
  triangleIndices: readonly number[],
  planarTolerance: number,
): FaceCluster[] {
  const clusters: FaceCluster[] = [];
  for (const t of triangleIndices) {
    const { normal, area, centroid } = triangleGeometry(mesh, t);
    if (area <= 0) continue; // a degenerate triangle has no face direction to cluster by

    let best: FaceCluster | null = null;
    let bestDot = Number.NEGATIVE_INFINITY;
    for (const cluster of clusters) {
      const dot = normal.dot(cluster.normal);
      if (dot < NORMAL_CLUSTER_COS_THRESHOLD) continue;
      const offset = centroid.dot(cluster.normal);
      if (Math.abs(offset - cluster.planeOffset) > planarTolerance) continue;
      if (dot > bestDot) {
        bestDot = dot;
        best = cluster;
      }
    }

    if (best) {
      best.triangleIndices.push(t);
      best.area += area;
    } else {
      clusters.push({
        normal,
        planeOffset: centroid.dot(normal),
        triangleIndices: [t],
        area,
      });
    }
  }
  return clusters;
}

/** The pair of clusters with the largest combined area whose normals are nearly opposite. */
function findAntiparallelPair(clusters: FaceCluster[]): { a: FaceCluster; b: FaceCluster } | null {
  let best: { a: FaceCluster; b: FaceCluster } | null = null;
  let bestArea = 0;
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      const a = clusters[i];
      const b = clusters[j];
      if (!a || !b) continue;
      if (a.normal.dot(b.normal) > ANTIPARALLEL_COS_THRESHOLD) continue;
      const combined = a.area + b.area;
      if (combined > bestArea) {
        bestArea = combined;
        best = { a, b };
      }
    }
  }
  return best;
}

/**
 * Decide whether one connected mesh component is a flat panel, and if so,
 * measure it.
 */
export function detectSlab(mesh: WeldedMesh, triangleIndices: readonly number[]): SlabDetection {
  const totalArea = triangleIndices.reduce((sum, t) => sum + triangleGeometry(mesh, t).area, 0);
  if (totalArea <= 0) return { ok: false, reason: 'no-planar-faces' };

  const diagonal = componentDiagonal(mesh, triangleIndices);
  const planarTolerance = diagonal > 0 ? diagonal * PLANAR_TOLERANCE_FRACTION : Number.EPSILON;

  const clusters = clusterFaces(mesh, triangleIndices, planarTolerance);
  const pair = findAntiparallelPair(clusters);
  if (!pair) return { ok: false, reason: 'no-planar-faces' };

  const { a: top, b: bottom } = pair;
  const largerArea = Math.max(top.area, bottom.area);
  if (Math.abs(top.area - bottom.area) / largerArea > AREA_MISMATCH_TOLERANCE) {
    return { ok: false, reason: 'unequal-faces' };
  }
  if ((top.area + bottom.area) / totalArea < MIN_TOP_BOTTOM_AREA_FRACTION) {
    return { ok: false, reason: 'no-planar-faces' };
  }

  const topBottomSet = new Set([...top.triangleIndices, ...bottom.triangleIndices]);
  let wallArea = 0;
  for (const t of triangleIndices) {
    if (topBottomSet.has(t)) continue;
    const { normal, area } = triangleGeometry(mesh, t);
    if (area <= 0) continue;
    if (Math.abs(normal.dot(top.normal)) > WALL_PERPENDICULAR_DOT_THRESHOLD) continue;
    wallArea += area;
  }

  const accounted = top.area + bottom.area + wallArea;
  if ((totalArea - accounted) / totalArea > MAX_UNACCOUNTED_AREA_FRACTION) {
    return { ok: false, reason: 'unaccounted-geometry' };
  }

  const thickness = Math.abs(top.planeOffset - bottom.planeOffset);

  return {
    ok: true,
    thickness,
    topNormal: top.normal,
    topTriangleIndices: [...top.triangleIndices],
    bottomTriangleIndices: [...bottom.triangleIndices],
  };
}
