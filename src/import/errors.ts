/**
 * Every word the importer says to a user, and every cap those words quote.
 *
 * `CLAUDE.md`'s rule is that a user always learns *which* construct was not
 * supported. That obliges the messages to be specific, and specific messages
 * scattered across a parser are how a construct ends up reported one way in the
 * walk and another way in the preview. So they live here, once, next to the
 * numbers they cite - the same argument M3 made for `toFormatUnit` living in
 * one place rather than being copied into `dxf.ts`.
 *
 * An `ImportError` is fatal: the file cannot be used at all, and nothing
 * reaches the preview. An `ImportWarning` is not: the importer proceeded, and
 * the user needs to know what it proceeded past.
 *
 * Lengths in these messages are millimetres, deliberately, even for a user
 * working in inches. `import/` may not depend on `ui/`, so the display unit is
 * not knowable here - and these strings are built during parsing, before the
 * preview that owns unit conversion exists. The parts table is where a user
 * reads sizes in their own unit; a warning is where they read what went wrong.
 */

import type { ImportWarning } from './types';

// --- Caps -----------------------------------------------------------------

/**
 * A 40MB SVG map of Europe is not a cut list, and the failure mode of not
 * saying so is a hung tab. Parsing runs synchronously on the main thread by
 * design, so the caps are what bound the worst input rather than a worker.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Shapes taken from one document, past which the file is not a cut list. */
export const MAX_SHAPES = 2000;

/**
 * How far a `use` chain is followed. Clones are exactly how somebody draws six
 * identical shelves, so they are resolved rather than ignored - but a chain
 * this deep is a generated file, not a drawing.
 */
export const MAX_USE_DEPTH = 8;

// --- Errors ---------------------------------------------------------------

export type ImportErrorKind =
  | 'file-too-large'
  | 'not-xml'
  | 'not-svg'
  | 'too-many-shapes'
  | 'empty-drawing';

/**
 * A returned value, not a thrown one - the same shape as `LengthParseError` in
 * `domain/units.ts`, and for the same reason. A malformed file is something a
 * user can act on, so it owes them a message rather than a stack trace.
 */
export interface ImportError {
  kind: ImportErrorKind;
  message: string;
}

export function fileTooLarge(bytes: number): ImportError {
  return {
    kind: 'file-too-large',
    message:
      `This file is ${megabytes(bytes)}, and the importer stops at ${megabytes(MAX_FILE_BYTES)}. ` +
      'A drawing that big is usually a traced image or a map rather than a cut list - ' +
      'try exporting just the layer your parts are on.',
  };
}

export function notXml(): ImportError {
  return {
    kind: 'not-xml',
    message:
      'This file could not be read as XML, so nothing in it could be parsed. ' +
      'A file that arrived by download or email is sometimes truncated - try exporting it again.',
  };
}

export function notSvg(rootElementName: string): ImportError {
  return {
    kind: 'not-svg',
    message:
      `This file's outermost element is <${rootElementName}>, not <svg>. ` +
      'Save it as a plain SVG rather than an HTML page or a compressed .svgz.',
  };
}

export function tooManyShapes(): ImportError {
  return {
    kind: 'too-many-shapes',
    message:
      `This drawing has more than ${MAX_SHAPES} shapes, which is far more than a cut list needs. ` +
      'Delete or hide everything that is not a part, then export again.',
  };
}

export function emptyDrawing(): ImportError {
  return {
    kind: 'empty-drawing',
    message:
      'No shapes were found in this file. ' +
      'If the parts are on a hidden layer, unhide it and export again - hidden layers are skipped.',
  };
}

// --- Warnings -------------------------------------------------------------

/**
 * Each builder takes the number of occurrences it stands for, because the
 * caller counts as it walks and builds one entry at the end. `count` is folded
 * on the kind *and* the message together: `unsupported-element` covers every
 * unsupported element there is, and reporting "8 unsupported elements" instead
 * of "3 text, 5 images" throws away the only part a user can act on.
 */
export function unsupportedElement(elementName: string, count: number): ImportWarning {
  return {
    kind: 'unsupported-element',
    count,
    message:
      `${count} <${elementName}> ${were(count, 'element')} skipped. ` +
      'The importer reads shapes, not text or images - if those are part outlines, ' +
      'convert them to paths in your editor and export again.',
  };
}

export function clippedGeometry(count: number): ImportWarning {
  return {
    kind: 'clipped-geometry',
    count,
    message:
      `${count} ${were(count, 'shape')} clipped or masked. ` +
      'The importer takes the full, unclipped outline, so those parts can come in larger ' +
      'than they look on screen - check their sizes against your drawing before cutting.',
  };
}

export function stylesheetNotRead(): ImportWarning {
  return {
    kind: 'stylesheet-not-read',
    count: 1,
    message:
      'This file has a <style> block that sets display or visibility. ' +
      'The importer does not read stylesheets, so shapes your drawing hides may appear in ' +
      'this list. Remove any row you did not expect.',
  };
}

export function degenerateShape(count: number): ImportWarning {
  return {
    kind: 'degenerate-shape',
    count,
    message:
      `${count} ${were(count, 'shape')} too small to be a part and ${was(count)} dropped. ` +
      'Construction lines, registration marks and stray points are the usual cause.',
  };
}

export function openPath(largestGapMm: number, count: number): ImportWarning {
  return {
    kind: 'open-path',
    count,
    message:
      `${count} ${were(count, 'outline')} not closed - ` +
      `${count === 1 ? 'the gap is' : 'the largest gap is'} ${mm(largestGapMm)}. ` +
      `An open outline is not a part, so ${count === 1 ? 'it was' : 'they were'} skipped. ` +
      'Close the path in your editor and export again.',
  };
}

export function unparseablePath(count: number): ImportWarning {
  return {
    kind: 'unparseable-path',
    count,
    message:
      `${count} ${were(count, 'path')} written in a form the importer could not read, ` +
      `so ${count === 1 ? 'it was' : 'they were'} skipped. A file that arrived by download or ` +
      'email is sometimes truncated - try exporting it again.',
  };
}

export function holeDiscarded(count: number): ImportWarning {
  return {
    kind: 'hole-discarded',
    count,
    message:
      `${count} interior ${were(count, 'cutout')} discarded. ` +
      'A table saw cuts edge to edge, so a hole is not part of the layout - ' +
      'drill or rout it after the sheet is cut. The parts around them are the right size.',
  };
}

export function shearedShape(count: number): ImportWarning {
  return {
    kind: 'sheared-shape',
    count,
    message:
      `${count} ${were(count, 'shape')} skewed rather than simply rotated. ` +
      'The smallest rectangle around a skewed shape is bigger than the shape itself, ' +
      'so these import oversized. They are flagged in the list below.',
  };
}

export function sizeSpread(largestSpreadMm: number, count: number): ImportWarning {
  return {
    kind: 'size-spread',
    count,
    message:
      `${count} ${were(count, 'row')} grouped from shapes that are not quite the same size - ` +
      `the largest disagreement is ${mm(largestSpreadMm)}. Each row takes the largest of its ` +
      'shapes, so nothing imports undersized, but the drawing itself may be inconsistent.',
  };
}

export function sliceAspect(): ImportWarning {
  return {
    kind: 'slice-aspect',
    count: 1,
    message:
      'This drawing asks to be cropped to fit its frame (preserveAspectRatio "slice"). ' +
      'The importer fits the whole drawing instead, so nothing was cut off - ' +
      'but check the overall size before committing.',
  };
}

export function unparseableTransform(attribute: string, count: number): ImportWarning {
  return {
    kind: 'unparseable-transform',
    count,
    message:
      `${count} transform ${were(count, 'attribute')} not understood: "${attribute}". ` +
      `Everything drawn under ${count === 1 ? 'it' : 'them'} was skipped, rather than placed ` +
      'at a position that would have been wrong.',
  };
}

export function cloneNotResolved(count: number): ImportWarning {
  return {
    kind: 'use-not-resolved',
    count,
    message:
      `${count} cloned ${plural(count, 'shape')} could not be resolved - the clone chain was ` +
      `deeper than ${MAX_USE_DEPTH} levels or referred back to itself. ` +
      `${count === 1 ? 'That copy is' : 'Those copies are'} missing from this list. ` +
      'The originals are not.',
  };
}

// --- Message helpers ------------------------------------------------------

/**
 * `noun` singular or plural, followed by the right form of "to be".
 *
 * "1 shapes were skipped" reads as a bug in the app, which makes a user trust
 * the number less than they should.
 */
function were(count: number, noun: string): string {
  return count === 1 ? `${noun} was` : `${noun}s were`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function was(count: number): string {
  return count === 1 ? 'was' : 'were';
}

/** A millimetre value at the precision a saw can act on, with no trailing zeros. */
function mm(value: number): string {
  return `${Number(value.toFixed(2))}mm`;
}

function megabytes(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(1))}MB`;
}
