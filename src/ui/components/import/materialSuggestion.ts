/**
 * Which material a detected thickness most plausibly means.
 *
 * Advisory only, never binding - `docs/plan-m5.md` §2 draws the line: measured
 * thickness pre-selects the closest *existing* material within a tolerance, it
 * never creates or edits one. When nothing is close enough to be a plausible
 * match, the caller's own fallback (today: the current material filter, or
 * the first material) is used instead, exactly the default an SVG row - which
 * carries no thickness at all - already gets.
 */

import type { Material } from '../../../domain/types';

/**
 * How far a detected thickness may sit from a material's own, in millimetres,
 * and still count as a match. Real sheet goods commonly measure a little
 * under their nominal thickness (18mm ply often measures closer to 17.5mm),
 * so this is loose enough to absorb that without being loose enough to
 * conflate two materials a woodworker would consider genuinely different
 * (12mm and 18mm ply, say).
 */
export const MATERIAL_THICKNESS_MATCH_TOLERANCE_MM = 1.5;

export function suggestMaterialId(
  thicknessMm: number | null,
  materials: readonly Material[],
  fallbackId: string,
): string {
  if (thicknessMm === null) return fallbackId;

  let best: Material | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const material of materials) {
    const diff = Math.abs(material.thickness - thicknessMm);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = material;
    }
  }

  if (best && bestDiff <= MATERIAL_THICKNESS_MATCH_TOLERANCE_MM) return best.id;
  return fallbackId;
}
