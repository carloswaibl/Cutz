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
 * The success case, widened with per-part thickness.
 *
 * Thickness never joins the shared `ImportedPart`/`ImportOutcome` contract
 * (`docs/plan-m5.md` §8 decision 4 - it is UI-layer information, used once to
 * pre-select a material) but the preview still needs it somewhere. It rides
 * beside the outcome, keyed by the same `sourceId` strings that already
 * survive grouping into `ImportedPart.sourceIds`, so a caller that knows it
 * is looking at STL output (and only that caller) can look thickness up per
 * row without widening the SVG-and-STL-generic type.
 */
export type StlImportOutcome =
  | (Extract<ImportOutcome, { ok: true }> & { thicknessMm: Record<string, number> })
  | Extract<ImportOutcome, { ok: false }>;

/**
 * Parse one STL file into parts.
 *
 * A file's mesh is split into connected components first; each is
 * independently validated as a slab or rejected (`docs/plan-m5.md` §8
 * decision 2) - a body with several disconnected shapes fused into one STL
 * export is a real CAD workflow, not a hypothetical one.
 *
 * `options.mmPerUnitOverride`, once a user confirms a real-world size in the
 * preview (PR 3), scales the raw mesh positions before anything else runs.
 * This matters beyond just reporting the right numbers: `group.ts`'s and
 * `contours.ts`'s grouping/hole-nesting tolerances are absolute millimetres,
 * and without this the mesh's raw units - which are not guaranteed to be
 * anywhere near millimetre-scale (a mesh modelled in inches or metres is a
 * real case, not a hypothetical one) - would silently feed those tolerances
 * the wrong-scale numbers. Every other tolerance in this pipeline (welding,
 * slab's planar tolerance) is already relative to the mesh's own bounding
 * box, so rescaling the raw positions and re-running the same pipeline is
 * correct and needs no special-casing past this one point of entry.
 */
export function importStl(
  bytes: ArrayBuffer,
  filename: string,
  options?: { mmPerUnitOverride?: number },
): StlImportOutcome {
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

  const scale = options?.mmPerUnitOverride ?? 1;
  if (scale !== 1) {
    const scaled = new Float32Array(soup.positions.length);
    for (let i = 0; i < soup.positions.length; i += 1) {
      scaled[i] = (soup.positions[i] ?? 0) * scale;
    }
    soup = { positions: scaled };
  }

  const mesh = weldTriangleSoup(soup);
  const components = splitComponents(mesh);

  const warnings: ImportWarning[] = [];
  let discardedHoles = 0;
  const accepted: { box: OrientedBox; sourceId: string }[] = [];
  const thicknessMm: Record<string, number> = {};

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
      const sourceId = `${filename}#${index}${nested.outers.length > 1 ? `-${outerIndex}` : ''}`;
      accepted.push({ box: outer.box, sourceId });
      thicknessMm[sourceId] = slab.thickness;
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
  //
  // `row.box` is already in post-`scale` space (the raw positions were scaled
  // before parsing began), so this is divided back down by `scale` to keep
  // `extentWidth`/`extentHeight` in raw units - the contract every caller of
  // `mmPerUnitOverride = enteredMm / extentWidth` depends on, unchanged by
  // whether this particular call happened to already carry a scale.
  let extentWidth: number | null = null;
  let extentHeight: number | null = null;
  let largestArea = -1;
  for (const row of rows) {
    const area = row.box.width * row.box.height;
    if (area > largestArea) {
      largestArea = area;
      extentWidth = row.box.width / scale;
      extentHeight = row.box.height / scale;
    }
  }

  return {
    ok: true,
    parts: grouped.parts,
    warnings: [...warnings, ...grouped.warnings],
    scale: scale === 1 ? { kind: 'none' } : { kind: 'user', mmPerUnit: scale },
    drawingWidthMm: scale === 1 ? null : extentWidth === null ? null : extentWidth * scale,
    drawingHeightMm: scale === 1 ? null : extentHeight === null ? null : extentHeight * scale,
    extentWidth,
    extentHeight,
    thicknessMm,
  };
}
