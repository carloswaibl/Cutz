/**
 * Bytes to a triangle soup - the thinnest possible wrapper over `STLLoader`.
 *
 * `STLLoader` already implements the standard binary/ASCII sniffing rule
 * (including the "solid"-prefixed-binary edge case some exporters produce),
 * which is exactly the kind of byte-level parsing worth using a maintained
 * implementation for rather than hand-rolling - see `docs/plan-m5.md` §8
 * decision 1. Nothing past this file needs to know which variant a file was.
 */

import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/**
 * A flat, unwelded triangle list straight from the file: every 9 consecutive
 * numbers is one triangle's three vertices (`x0 y0 z0 x1 y1 z1 x2 y2 z2`), in
 * whatever raw units the file was modelled in - `docs/plan-m5.md` §4.7 is
 * explicit that STL carries none, so nothing here may assume millimetres.
 *
 * Deliberately not a `BufferGeometry`: everything downstream of this module
 * is plain arrays and headless math, so a mesh never depends on three's
 * runtime beyond this one parsing step.
 */
export interface TriangleSoup {
  positions: Float32Array;
}

/**
 * The file's stored per-vertex normal is not read here, deliberately: a
 * malformed export can carry a zero or garbage normal, and `mesh.ts` computes
 * its own face normals from vertex positions instead of trusting the file.
 */
export function parseStlBytes(bytes: ArrayBuffer): TriangleSoup {
  const geometry = new STLLoader().parse(bytes);
  const position = geometry.getAttribute('position');
  return { positions: position.array as Float32Array };
}
