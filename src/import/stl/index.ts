/**
 * Bytes to `ImportOutcome` - the STL importer's entry point.
 *
 * Wires PR 1's pure mesh math (`parse.ts`, `mesh.ts`, `slab.ts`, `project.ts`)
 * into the same shape SVG's `importSvg` already produces: a component that
 * fails validation becomes a counted warning and is excluded; the others
 * still import (`docs/plan-m5.md` exit criterion 4). Every import starts
 * with `scale: { kind: 'none' }` - STL carries no unit information at all,
 * so there is exactly one path, unlike SVG's several (§4.7).
 */

import { type Contour, nestContours } from '../contours';
import {
  fileTooLarge,
  holeDiscarded,
  MAX_FILE_BYTES,
  nonManifoldMesh,
  notASlab,
  notStl,
} from '../errors';
import { isDegenerate, minAreaBox, type OrientedBox } from '../geometry';
import { groupRows, type ShapeRow } from '../group';
import type { ImportOutcome, ImportWarning } from '../types';
import { componentLabel } from './label';
import {
  checkManifold,
  type MeshComponent,
  splitComponents,
  type WeldedMesh,
  weldTriangleSoup,
} from './mesh';
import { parseStlBytes } from './parse';
import { projectTopFace } from './project';
import { detectSlab } from './slab';

/**
 * A rejected component is identified by its position in the file and its
 * rough size in the file's own (still-unscaled) units - it never earned a
 * label, since only accepted components do (`docs/plan-m5.md` §4.4 step 5).
 */
function describeComponent(
  mesh: WeldedMesh,
  component: MeshComponent,
  index: number,
  filename: string,
): string {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const t of component.triangleIndices) {
    const base = t * 3;
    for (const vertexIndex of [
      mesh.triangles[base],
      mesh.triangles[base + 1],
      mesh.triangles[base + 2],
    ]) {
      if (vertexIndex === undefined) continue;
      const vbase = vertexIndex * 3;
      const x = mesh.positions[vbase];
      const y = mesh.positions[vbase + 1];
      const z = mesh.positions[vbase + 2];
      if (x === undefined || y === undefined || z === undefined) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const dims = Number.isFinite(minX)
    ? `roughly ${(maxX - minX).toFixed(2)} x ${(maxY - minY).toFixed(2)} x ${(maxZ - minZ).toFixed(2)} in the file's own units`
    : 'no measurable extent';
  return `component ${index + 1} of "${filename}", ${dims}`;
}

/**
 * Parse one STL file into parts.
 *
 * A file's mesh is split into connected components first; each is
 * independently validated as a slab or rejected (`docs/plan-m5.md` §8
 * decision 2) - a body with several disconnected shapes fused into one STL
 * export is a real CAD workflow, not a hypothetical one.
 */
export function importStl(bytes: ArrayBuffer, filename: string): ImportOutcome {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: fileTooLarge(bytes.byteLength) };
  }

  let soup: ReturnType<typeof parseStlBytes>;
  try {
    soup = parseStlBytes(bytes);
  } catch {
    return { ok: false, error: notStl() };
  }
  // Zero positions means zero triangles - STLLoader always emits exactly
  // three vertices per triangle, so there is no distinct "valid but empty"
  // case to report differently from "unreadable".
  if (soup.positions.length === 0) {
    return { ok: false, error: notStl() };
  }

  const mesh = weldTriangleSoup(soup);
  const components = splitComponents(mesh);

  const warnings: ImportWarning[] = [];
  let discardedHoles = 0;
  const accepted: { box: OrientedBox; sourceId: string }[] = [];

  components.forEach((component, index) => {
    const manifold = checkManifold(mesh, component);
    if (!manifold.manifold) {
      warnings.push(nonManifoldMesh(describeComponent(mesh, component, index, filename), 1));
      return;
    }

    const slab = detectSlab(mesh, component.triangleIndices);
    if (!slab.ok) {
      warnings.push(notASlab(slab.reason, describeComponent(mesh, component, index, filename)));
      return;
    }

    const loops = projectTopFace(mesh, slab.topTriangleIndices, slab.topNormal);
    const contours: Contour[] = loops
      .map((points): Contour => ({ points, box: minAreaBox(points) }))
      .filter((contour) => !isDegenerate(contour.box));
    const nested = nestContours(contours);
    discardedHoles += nested.holeCount;

    nested.outers.forEach((outer, outerIndex) => {
      accepted.push({
        box: outer.box,
        sourceId: `${filename}#${index}${nested.outers.length > 1 ? `-${outerIndex}` : ''}`,
      });
    });
  });

  if (discardedHoles > 0) warnings.push(holeDiscarded(discardedHoles));

  const rows: ShapeRow[] = accepted.map((entry, i) => ({
    label: componentLabel(filename, i, accepted.length),
    box: entry.box,
    sourceId: entry.sourceId,
    // Nothing in mesh projection produces a parallelogram the way an SVG
    // shear does (`docs/plan-m5.md` §3.2) - STL rows are never sheared.
    sheared: false,
  }));

  const grouped = groupRows(rows);

  // The largest accepted component's own projected extent, in the file's raw
  // units - what the per-file scale control (PR 3) anchors on when there is
  // more than one part in the file. `docs/plan-m5.md` doesn't resolve which
  // part's extent should represent a multi-part file; the largest by area is
  // the most defensible single number.
  let extentWidth: number | null = null;
  let extentHeight: number | null = null;
  let largestArea = -1;
  for (const row of rows) {
    const area = row.box.width * row.box.height;
    if (area > largestArea) {
      largestArea = area;
      extentWidth = row.box.width;
      extentHeight = row.box.height;
    }
  }

  return {
    ok: true,
    parts: grouped.parts,
    warnings: [...warnings, ...grouped.warnings],
    scale: { kind: 'none' },
    drawingWidthMm: null,
    drawingHeightMm: null,
    extentWidth,
    extentHeight,
  };
}
