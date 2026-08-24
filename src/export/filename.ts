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
  projectName: string;
  /** 1-based, matching the sheet tabs in the UI. */
  sheetNumber: number;
  material: Material;
  extension: 'svg' | 'dxf';
}

/** `cutz-bookshelf-sheet-2-18mm-birch-ply.svg`. */
export function sheetFileName({
  projectName,
  sheetNumber,
  material,
  extension,
}: SheetFileNameInput): string {
  const projectSlug = slugify(projectName);
  const materialSlug = slugify(material.name);
  const base = projectSlug
    ? `cutz-${projectSlug}-sheet-${sheetNumber}`
    : `cutz-sheet-${sheetNumber}`;
  return materialSlug ? `${base}-${materialSlug}.${extension}` : `${base}.${extension}`;
}

/** Lowercase ASCII, single dashes, no leading or trailing dash. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
