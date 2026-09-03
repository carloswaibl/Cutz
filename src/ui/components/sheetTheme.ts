/**
 * Colour themes for the sheet diagram.
 *
 * The same renderer draws to three destinations - screen, print, and exported
 * SVG - and only the palette differs between them. Hardcoding the screen's dark
 * colours inside the renderer would force a second renderer for paper, and two
 * renderers of the same drawing eventually disagree about what they are drawing.
 *
 * So every colour the diagram uses lives here, and `SheetFigure` takes a theme
 * as a prop.
 *
 * `SCREEN_THEME` is the dark palette the app has always used, extracted value
 * for value. `PRINT_THEME` is for paper and for files that leave the app: dark
 * ink on white, light fills that a shop printer can render without draining a
 * cartridge, and enough contrast that a diagram photocopied at the lumber yard
 * is still readable.
 */

export interface SheetTheme {
  /** Background behind the whole diagram, including the padding around the sheet. */
  background: string;
  /** Rounded rect covering the full stock sheet. */
  sheetFill: string;
  sheetStroke: string;
  /** Dashed boundary of the usable area, drawn only when edgeTrim > 0. */
  usableStroke: string;
  /** Stock dimension labels, the trim callout, and the GRAIN caption. */
  dimensionText: string;

  /**
   * Fill colours for placed parts, cycled by part index. Ten entries, distinct
   * from each other at both fill opacities below.
   */
  partPalette: readonly string[];
  partFillOpacity: number;
  partFillOpacityHovered: number;
  /** Outline of a hovered part. Parts are otherwise outlined in their own fill colour. */
  partStrokeHovered: string;
  /**
   * The true outline drawn inside a part's bounding box in guillotine mode.
   *
   * Only ever a hint: on a table saw the rectangle is what gets cut, so the
   * shape inside it is information about what the blank contains, not about the
   * cut. Deliberately faint for that reason - anything stronger reads as a cut
   * line the saw is going to make. Unused in nest mode, where the outline *is*
   * the cut and is drawn in the part's own colour.
   */
  partOutlineHint: string;
  partOutlineHintOpacity: number;
  partLabelText: string;
  partLabelTextHovered: string;
  partDimText: string;
  partDimTextHovered: string;

  /** Dashed line showing where the blade runs between two parts. */
  kerfLine: string;
  kerfLineOpacity: number;

  /** Grain arrow badge in the sheet's top-left corner. */
  grainPillFill: string;
  grainPillFillOpacity: number;
  grainPillStroke: string;
  grainArrow: string;

  /** Cut-plan overlay: the blade line for one step, and its step number badge. */
  cutLine: string;
  cutNumberFill: string;
  cutNumberStroke: string;
  cutNumberText: string;

  /** Title block above the sheet, drawn only when `showTitle` is set. */
  titleText: string;
  titleSubText: string;
}

/**
 * Ten visually distinct hues, cycled when a project has more parts than colours.
 * Shared by both themes: the hues read correctly on dark and on white, and a
 * printed diagram matching the colours on screen is worth more than a palette
 * tuned separately for each.
 */
const PART_PALETTE = [
  '#3b82f6', // blue-500
  '#f59e0b', // amber-500
  '#10b981', // emerald-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#f97316', // orange-500
  '#84cc16', // lime-500
  '#6366f1', // indigo-500
] as const;

export const SCREEN_THEME: SheetTheme = {
  background: '#0f172a',
  sheetFill: '#1e293b',
  sheetStroke: '#334155',
  usableStroke: '#475569',
  dimensionText: '#64748b',

  partPalette: PART_PALETTE,
  partFillOpacity: 0.25,
  partFillOpacityHovered: 0.45,
  partStrokeHovered: '#fbbf24',
  partOutlineHint: '#e2e8f0',
  partOutlineHintOpacity: 0.45,
  partLabelText: '#f1f5f9',
  partLabelTextHovered: '#fef3c7',
  partDimText: '#94a3b8',
  partDimTextHovered: '#fde68a',

  kerfLine: '#ef4444',
  kerfLineOpacity: 0.4,

  grainPillFill: '#0f172a',
  grainPillFillOpacity: 0.7,
  grainPillStroke: '#334155',
  grainArrow: '#94a3b8',

  cutLine: '#fbbf24',
  cutNumberFill: '#0f172a',
  cutNumberStroke: '#fbbf24',
  cutNumberText: '#fbbf24',

  titleText: '#f1f5f9',
  titleSubText: '#94a3b8',
};

export const PRINT_THEME: SheetTheme = {
  // White rather than the app's off-white: this is the ground the sheet sits on
  // in an exported file, and anything else prints as a full-page block of ink.
  background: '#ffffff',
  sheetFill: '#ffffff',
  sheetStroke: '#0f172a',
  usableStroke: '#94a3b8',
  dimensionText: '#475569',

  partPalette: PART_PALETTE,
  // Lighter than on screen. A part fill is a tint identifying the part, not a
  // solid - the label sitting on top of it has to stay readable in greyscale.
  partFillOpacity: 0.18,
  partFillOpacityHovered: 0.3,
  partStrokeHovered: '#b45309',
  // Darker than the screen's hint and slightly more opaque: a pale grey line at
  // 0.45 is legible on a monitor and gone on a photocopy.
  partOutlineHint: '#64748b',
  partOutlineHintOpacity: 0.7,
  partLabelText: '#0f172a',
  partLabelTextHovered: '#0f172a',
  partDimText: '#475569',
  partDimTextHovered: '#475569',

  // Stronger than on screen: a 0.4-opacity hairline survives a monitor and
  // disappears on a 300dpi laser printer.
  kerfLine: '#dc2626',
  kerfLineOpacity: 0.65,

  grainPillFill: '#f1f5f9',
  grainPillFillOpacity: 1,
  grainPillStroke: '#cbd5e1',
  grainArrow: '#475569',

  cutLine: '#0f172a',
  cutNumberFill: '#ffffff',
  cutNumberStroke: '#0f172a',
  cutNumberText: '#0f172a',

  titleText: '#0f172a',
  titleSubText: '#475569',
};
