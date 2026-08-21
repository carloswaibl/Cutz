/**
 * The shared importer contract.
 *
 * Written for two importers from the start - SVG now, STL in M5 - because
 * writing it for one and retrofitting the other is how the SVG's assumptions
 * end up baked into the STL path. Nothing in this file mentions SVG.
 *
 * This is the project's first *untrusted* input. Everything the app has
 * consumed so far it also produced: presets, the solver's own output, values a
 * user typed into a validated field. A file comes from someone else's software
 * and is under nobody's control, so the job of an importer is not to succeed -
 * it is to be specific. The difference between "this file didn't work" and
 * "the three text elements on layer 2 were skipped, and the drawing was assumed
 * to be 96 px per inch" is the whole feature.
 *
 * Every dimension here is millimetres, like everything else outside the UI.
 * User-facing strings live in `errors.ts`, not here: this file is data shapes
 * only, so that there is exactly one place to read to know what the app says.
 */

// Type-only, and cyclic with `errors.ts` by design: this file owns the shapes,
// that one owns the words. Both erase at compile time, so there is no cycle at
// runtime and no bundler edge to worry about.
import type { ImportError } from './errors';

// --- Scale ----------------------------------------------------------------

/**
 * Where the millimetre scale came from. The preview says this out loud.
 *
 * The units policy is *prompt, do not guess*, and this type is what makes that
 * enforceable rather than aspirational: a scale that was assumed is a different
 * value of the same type as one that was declared, so no call site can lose the
 * distinction on the way to the screen.
 */
export type ScaleSource =
  /** The document stated a physical size, e.g. `width="210mm"`. */
  | { kind: 'declared'; unit: string; mmPerUnit: number }
  /**
   * Unitless or `px` dimensions. The spec defines a px as 1/96in so a scale
   * *is* derivable, but Inkscape before 0.92 used 90dpi and those files are
   * still in the wild, so this is an assumption and is labelled as one.
   */
  | { kind: 'assumed-px'; mmPerUnit: number }
  /** The user overrode whatever was detected. */
  | { kind: 'user'; mmPerUnit: number }
  /** Nothing to go on. Blocks import until the user supplies a scale. */
  | { kind: 'none' };

// --- Parts ----------------------------------------------------------------

/**
 * An advisory annotation on an imported row.
 *
 * Deliberately *not* tick state. Every row that reaches the preview is a part -
 * shapes too small to be one are dropped upstream with a counted warning rather
 * than arriving pre-unticked, so there is never a second source of truth for
 * whether a row is wanted. A flag says "look at this one", and the user decides.
 */
export type PartFlag =
  /**
   * Shapes grouped into this row disagreed about their size by more than the
   * flagging threshold. Usually the drawing itself is inconsistent, and the
   * user wants to know before it becomes six shelves of slightly different
   * length.
   */
  | { kind: 'size-spread'; spreadMm: number }
  /**
   * A shear in the composed transform turned this rectangle into a
   * parallelogram, so its enclosing box is strictly larger than the shape. This
   * cannot be corrected, only reported - hence a flag rather than a fix.
   */
  | { kind: 'sheared' };

export interface ImportedPart {
  /** Best label the source could offer. Never empty. */
  label: string;
  /** Millimetres. */
  width: number;
  /** Millimetres. */
  height: number;
  qty: number;
  /**
   * Degrees the shape was drawn at, 0 when square to the canvas. Reported so a
   * user can see the oriented box did the right thing; not stored on the Part.
   */
  angle: number;
  flags: PartFlag[];
  /** Source element ids behind this row, for the preview's "3 shapes" affordance. */
  sourceIds: string[];
}

// --- Warnings -------------------------------------------------------------

/**
 * Something the importer proceeded past and the user must be told about.
 *
 * The list is exhaustive on purpose. `docs/plan-m4.md` §4 documents the
 * supported subset, and an enumerated union is what stops the code and that
 * document drifting apart - adding a skip without adding a kind does not
 * compile.
 */
export type ImportWarningKind =
  /** `text`, `image`, `foreignObject`, and anything else in a geometry position. */
  | 'unsupported-element'
  /** A `clipPath` or `mask`. Matters more than the others: we take the *unclipped* path. */
  | 'clipped-geometry'
  /** A `<style>` block that might hide something. We do not parse CSS to find out. */
  | 'stylesheet-not-read'
  /** Construction lines, registration marks, and anything with no real extent. */
  | 'degenerate-shape'
  /** A contour whose ends do not meet. Not a part. */
  | 'open-path'
  /** A `d` attribute that could not be read as path data at all. */
  | 'unparseable-path'
  /** An interior cutout. A table saw does not produce those. */
  | 'hole-discarded'
  /** A sheared shape, whose box is oversized. Pairs with `PartFlag`'s `sheared`. */
  | 'sheared-shape'
  /** A grouped row whose members disagreed. Pairs with `PartFlag`'s `size-spread`. */
  | 'size-spread'
  /** `preserveAspectRatio` asked to slice. We treat it as meet and say so. */
  | 'slice-aspect'
  /** A `transform` attribute we could not parse. The subtree is skipped, never assumed identity. */
  | 'unparseable-transform'
  /** A `use` chain too deep, or one that refers back to itself. */
  | 'use-not-resolved';

export interface ImportWarning {
  kind: ImportWarningKind;
  /**
   * Occurrences folded into one entry.
   *
   * Warnings fold on `kind` *and* `message` together, not on `kind` alone.
   * `unsupported-element` covers every unsupported element there is, and the
   * name of the construct lives in the message - folding on the kind alone
   * would report "8 unsupported elements" and lose the fact that three were
   * text and five were images, which is the only part a user can act on.
   */
  count: number;
  /** User-facing, names the construct and says what to do. Never generic. */
  message: string;
}

// --- Outcome --------------------------------------------------------------

/**
 * An `ImportError` is a file the app cannot proceed with at all; an
 * `ImportWarning` is something it proceeded past. Mixing the two is what
 * produces importers that either throw on a stray `<text>` or silently drop
 * half a drawing.
 */
export type ImportOutcome =
  | {
      ok: true;
      parts: ImportedPart[];
      warnings: ImportWarning[];
      scale: ScaleSource;
      /**
       * The drawing's overall size in millimetres, for the preview's "drawing
       * is ___ wide" control. Null exactly when `scale.kind` is `'none'` -
       * the numbers would be meaningless, there being nothing yet to be off
       * by a factor of.
       */
      drawingWidthMm: number | null;
      drawingHeightMm: number | null;
      /**
       * The same extent in raw user units, independent of whether a scale
       * could be derived. This is what a scale override divides into:
       * `mmPerUnitOverride = enteredWidthMm / extentWidth`. It is what lets
       * the preview compute a scale from scratch when `scale.kind` is
       * `'none'`, where `drawingWidthMm` has nothing to base a ratio on.
       * Null only when the root gave neither a viewBox nor a width/height to
       * measure at all.
       */
      extentWidth: number | null;
      extentHeight: number | null;
    }
  | { ok: false; error: ImportError };
