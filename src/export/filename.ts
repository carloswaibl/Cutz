/**
 * Naming exported files.
 *
 * Its own module rather than living beside the SVG exporter, because every
 * export format needs it and `svg.ts` pulls in `react-dom/server` - a 60 kB
 * chunk deliberately loaded on demand. A headless exporter reaching in here for
 * a filename must not drag a renderer along behind it.
 */

import type { Material } from '../domain/types';

export interface SheetFileNameInput {
  /** 1-based, matching the sheet tabs in the UI. */
  sheetNumber: number;
  material: Material;
  extension: 'svg' | 'dxf';
}

/**
 * `cutz-sheet-2-18mm-birch-ply.svg`.
 *
 * Project names arrive with IndexedDB persistence in M6 and will slot in ahead
 * of the sheet number.
 */
export function sheetFileName({ sheetNumber, material, extension }: SheetFileNameInput): string {
  const slug = slugify(material.name);
  return slug
    ? `cutz-sheet-${sheetNumber}-${slug}.${extension}`
    : `cutz-sheet-${sheetNumber}.${extension}`;
}

/** Lowercase ASCII, single dashes, no leading or trailing dash. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
