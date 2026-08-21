/**
 * A component's label starts from the source filename - STL carries no
 * per-shape text of any kind, unlike SVG's `title`/`id`/`inkscape:label`, so
 * the filename is the only thing a user actually named (`docs/plan-m5.md`
 * §4.8).
 */

/** Strip the `.stl` extension and read `_`/`-` as word separators. Case is left as typed. */
export function labelFromFilename(filename: string): string {
  const base = filename.replace(/\.stl$/i, '');
  return base.replace(/[_-]+/g, ' ').trim() || 'Part';
}

/**
 * A component's label: the file's own label, with an index suffix only when
 * the file's mesh split into more than one accepted component - a
 * single-component file's part is not "Shelf 1" for no reason.
 */
export function componentLabel(
  filename: string,
  componentIndex: number,
  acceptedCount: number,
): string {
  const base = labelFromFilename(filename);
  return acceptedCount > 1 ? `${base} ${componentIndex + 1}` : base;
}
