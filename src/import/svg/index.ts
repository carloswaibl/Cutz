/**
 * `importSvg` - the whole pipeline, from a string to parts.
 *
 * Everything above the preview is pure: a string and an options object in, a
 * plain data structure out. The only browser dependency in the whole layer is
 * `DOMParser`, in `document.ts`, which is why this is testable.
 *
 * The walk is the part with all the risk in it, and its shape is deliberate:
 * an explicit stack rather than recursion, so a pathologically nested file
 * cannot blow the call stack in a tab; document order preserved, so the parts
 * table comes out in the order the drawing reads; and every skip counted rather
 * than acted on immediately, because the messages in `errors.ts` bake their own
 * counts and building them eagerly would report twenty-two separate copies of
 * "1 <text> element was skipped".
 */

import {
  clippedGeometry,
  cloneNotResolved,
  degenerateShape,
  emptyDrawing,
  holeDiscarded,
  MAX_SHAPES,
  MAX_USE_DEPTH,
  openPath,
  shearedShape,
  stylesheetNotRead,
  tooManyShapes,
  unparseablePath,
  unparseableTransform,
  unsupportedElement,
} from '../errors';
import type { ImportOutcome, ImportWarning } from '../types';
import { type Contour, classifySubpath, nestContours } from './contours';
import { parseSvgDocument } from './document';
import { flattenPath } from './flatten';
import { groupRows, type ShapeRow } from './group';
import { explicitLabel, labelFor } from './label';
import { coord, isShapeElement, shapeToPathData } from './shapes';
import { isSheared, type Matrix, multiply, parseTransform, translation } from './transform';
import { resolveViewport } from './viewport';

export interface SvgImportOptions {
  /**
   * Millimetres per user unit, from the preview's scale control. Overrides
   * whatever the document declared, which is the fix for a 90dpi Inkscape file
   * or an export in the wrong unit.
   */
  mmPerUnitOverride?: number;
}

const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Walked for their children, contributing a transform but no geometry. */
const CONTAINERS: ReadonlySet<string> = new Set(['g', 'a', 'switch']);

/**
 * Read for their own purposes and never treated as shapes, silently.
 *
 * `defs` is here rather than among the unsupported: it is a definitions block,
 * its contents are reached through `use`, and warning about it would fire on
 * every Inkscape file ever saved.
 */
const IGNORED: ReadonlySet<string> = new Set([
  'defs',
  'title',
  'desc',
  'metadata',
  'style',
  'namedview',
  'clipPath',
  'mask',
  'linearGradient',
  'radialGradient',
  'pattern',
  'filter',
  'script',
]);

interface Frame {
  element: Element;
  ctm: Matrix;
  /** Enclosing group or layer name, for labelling shapes that have none. */
  layerName: string | null;
  /** A `use` element's own label, which wins over the cloned original's. */
  inheritedLabel: string | null;
  /** Element ids on the `use` chain that led here, for cycle detection. */
  useChain: readonly string[];
  /** False under a `visibility:hidden` ancestor that nothing re-showed. */
  visible: boolean;
}

/** Every skip, counted as it happens and worded once at the end. */
interface Tally {
  /** Element local name to occurrences. Insertion-ordered, so output is stable. */
  unsupported: Map<string, number>;
  /** Attribute text to occurrences, so the message can quote what failed. */
  badTransforms: Map<string, number>;
  clipped: number;
  degenerate: number;
  unparseablePaths: number;
  holes: number;
  sheared: number;
  cloneFailures: number;
  openPaths: number;
  largestGapMm: number;
  stylesheet: boolean;
}

/**
 * Parse an SVG into parts.
 *
 * A file with no parts but something to say about why is *not* an error: it
 * comes back `ok` with an empty list and its warnings intact. That distinction
 * is the whole point of the milestone - a drawing whose outlines are all `<text>`
 * needs to be told "22 text elements were skipped, convert them to paths",
 * which is actionable, and `emptyDrawing`'s "no shapes were found" is not.
 * `emptyDrawing` is reserved for a file that yielded nothing and had no
 * explanation for it either.
 */
export function importSvg(text: string, options: SvgImportOptions = {}): ImportOutcome {
  const parsed = parseSvgDocument(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const root = parsed.root;
  const viewport = resolveViewport(root, options.mmPerUnitOverride);

  const tally: Tally = {
    unsupported: new Map(),
    badTransforms: new Map(),
    clipped: 0,
    degenerate: 0,
    unparseablePaths: 0,
    holes: 0,
    sheared: 0,
    cloneFailures: 0,
    openPaths: 0,
    largestGapMm: 0,
    stylesheet: false,
  };

  tally.stylesheet = hidesThroughStylesheet(root);

  const rows: ShapeRow[] = [];
  let shapesSeen = 0;

  // Children of the root, not the root itself: the root's own transform is
  // already in the viewport matrix, and pushing it would apply it twice.
  const stack: Frame[] = childFrames(root, {
    element: root,
    ctm: viewport.matrix,
    layerName: null,
    inheritedLabel: null,
    useChain: [],
    visible: true,
  });

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const el = frame.element;
    const name = el.localName;

    // `display:none` cannot be undone by a descendant, so the subtree is gone.
    // This is how a hidden Inkscape layer disappears, which is the single most
    // common way a real file contains geometry its author does not consider
    // part of the drawing.
    if (isDisplayNone(el)) continue;

    const visible = visibilityOf(el) ?? frame.visible;

    if (IGNORED.has(name)) continue;

    // A `symbol` is a template. Reached through a `use` it is the thing being
    // cloned and is walked; sitting on its own it draws nothing, and §4.3 says
    // to say so rather than let a user wonder where their parts went.
    const isClonedTemplate = frame.useChain.length > 0 && (name === 'symbol' || name === 'svg');

    if (CONTAINERS.has(name) || isClonedTemplate) {
      const ctm = composed(el, frame.ctm, tally);
      if (!ctm) continue;
      const next: Frame = {
        ...frame,
        ctm,
        visible,
        layerName: groupLabel(el) ?? frame.layerName,
      };
      // A `switch` renders the first child whose requirements are met. Walking
      // every branch would import both alternatives of a drawing that shows one.
      const children = name === 'switch' ? firstChild(el) : Array.from(el.children);
      stack.push(...childFrames(el, next, children));
      continue;
    }

    if (name === 'use') {
      const resolved = resolveUse(el, frame, tally);
      if (resolved) stack.push(resolved);
      continue;
    }

    if (isShapeElement(name)) {
      if (!visible) continue;
      shapesSeen += 1;
      if (shapesSeen > MAX_SHAPES) return { ok: false, error: tooManyShapes() };

      const ctm = composed(el, frame.ctm, tally);
      if (!ctm) continue;
      collectShape(el, ctm, frame, rows, tally);
      continue;
    }

    // `text`, `image`, `foreignObject`, a nested `<svg>`, a stray `symbol`, and
    // anything an editor invented. All of them named in the warning, because
    // "which construct" is the only part a user can act on.
    tally.unsupported.set(name, (tally.unsupported.get(name) ?? 0) + 1);
  }

  const grouped = groupRows(rows);
  const warnings = [...materialise(tally), ...viewport.warnings, ...grouped.warnings];

  if (grouped.parts.length === 0 && warnings.length === 0) {
    return { ok: false, error: emptyDrawing() };
  }

  return {
    ok: true,
    parts: grouped.parts,
    warnings,
    scale: viewport.scale,
    drawingWidthMm: viewport.drawingWidthMm,
    drawingHeightMm: viewport.drawingHeightMm,
    extentWidth: viewport.extentWidth,
    extentHeight: viewport.extentHeight,
  };
}

// --- Geometry -------------------------------------------------------------

/**
 * Turn one shape element into rows.
 *
 * Hole nesting runs over **this element's** contours alone, not the document's.
 * A compound path is the one place SVG actually gives containment a meaning -
 * it is what Inkscape's Path > Difference and Illustrator's compound paths
 * produce, and what the even-odd fill rule acts on. Across separate elements
 * there is no such relationship: a circle drawn on top of a rectangle is two
 * objects, not a rectangle with a hole. Nesting document-wide would read any
 * background or frame rectangle as a panel with the entire drawing cut out of
 * it, and collapse the import to a single part.
 */
function collectShape(
  el: Element,
  ctm: Matrix,
  frame: Frame,
  rows: ShapeRow[],
  tally: Tally,
): void {
  const d = shapeToPathData(el);
  if (d === null) {
    tally.unparseablePaths += 1;
    return;
  }

  const subpaths = flattenPath(d, ctm);
  if (subpaths === null) {
    tally.unparseablePaths += 1;
    return;
  }

  const contours: Contour[] = [];
  for (const subpath of subpaths) {
    const classified = classifySubpath(subpath);
    if (classified.kind === 'degenerate') {
      tally.degenerate += 1;
    } else if (classified.kind === 'open') {
      tally.openPaths += 1;
      tally.largestGapMm = Math.max(tally.largestGapMm, classified.gapMm);
    } else {
      contours.push(classified.contour);
    }
  }

  const { outers, holeCount } = nestContours(contours);
  tally.holes += holeCount;
  if (outers.length === 0) return;

  const sheared = isSheared(ctm);
  if (sheared) tally.sheared += outers.length;
  if (isClipped(el)) tally.clipped += outers.length;

  const base =
    frame.inheritedLabel ?? labelFor(el, { layerName: frame.layerName, index: rows.length + 1 });

  outers.forEach((contour, i) => {
    rows.push({
      // A compound path holding a whole set of panels is common in Illustrator
      // output, and one name across all of them would be a table of duplicates.
      label: outers.length > 1 ? `${base} ${i + 1}` : base,
      box: contour.box,
      sourceId: el.getAttribute('id') || `${el.localName}@${rows.length + 1}`,
      sheared,
    });
  });
}

// --- Tree -----------------------------------------------------------------

function childFrames(parent: Element, template: Frame, children?: Element[]): Frame[] {
  const list = children ?? Array.from(parent.children);
  // Reversed, because the stack pops from the end and the parts table should
  // read in the order the drawing does.
  return list.map((element): Frame => ({ ...template, element })).reverse();
}

function firstChild(el: Element): Element[] {
  const first = el.children[0];
  return first ? [first] : [];
}

/**
 * The element's own transform composed onto its parent's, or null when the
 * attribute could not be read.
 *
 * Null prunes. Identity is the dangerous answer here: the shape still imports,
 * at a believable size, in the wrong place - and a part in the wrong place on a
 * sheet is indistinguishable from a correct import until it is cut.
 */
function composed(el: Element, parent: Matrix, tally: Tally): Matrix | null {
  const attribute = el.getAttribute('transform');
  if (attribute === null) return parent;
  const own = parseTransform(attribute);
  if (!own) {
    const seen = tally.badTransforms.get(attribute) ?? 0;
    tally.badTransforms.set(attribute, seen + 1);
    return null;
  }
  return multiply(parent, own);
}

/**
 * Follow a `use` to what it clones.
 *
 * Resolved rather than ignored because Inkscape clones are exactly how somebody
 * draws six identical shelves, and an importer that skips them returns one part
 * from a drawing that plainly shows six.
 */
function resolveUse(el: Element, frame: Frame, tally: Tally): Frame | null {
  const href =
    el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href') ?? el.getAttribute('xlink:href');

  // Only same-document references. A `use` pointing at another file is a fetch,
  // and this app does not make network requests.
  if (!href?.startsWith('#')) {
    tally.cloneFailures += 1;
    return null;
  }

  const id = href.slice(1);
  if (frame.useChain.length >= MAX_USE_DEPTH || frame.useChain.includes(id)) {
    tally.cloneFailures += 1;
    return null;
  }

  const target = el.ownerDocument.getElementById(id);
  if (!target || target === el) {
    tally.cloneFailures += 1;
    return null;
  }

  const withTransform = composed(el, frame.ctm, tally);
  if (!withTransform) return null;

  // `x` and `y` on a `use` are an extra translation, applied after its own
  // transform - which is what makes six clones of one template land in six
  // different places.
  const offset = translation(coord(el, 'x') ?? 0, coord(el, 'y') ?? 0);

  return {
    element: target,
    ctm: multiply(withTransform, offset),
    layerName: frame.layerName,
    // The clone's own name beats the template's: six `use` elements labelled
    // "Shelf 1".."Shelf 6" should not all import as the template's name.
    inheritedLabel: explicitLabel(el) ?? frame.inheritedLabel,
    useChain: [...frame.useChain, id],
    visible: visibilityOf(el) ?? frame.visible,
  };
}

// --- Attributes -----------------------------------------------------------

function isDisplayNone(el: Element): boolean {
  if (el.getAttribute('display')?.trim().toLowerCase() === 'none') return true;
  return inlineStyle(el, 'display') === 'none';
}

/** True, false, or null when this element says nothing and inherits. */
function visibilityOf(el: Element): boolean | null {
  const value =
    inlineStyle(el, 'visibility') ?? el.getAttribute('visibility')?.trim().toLowerCase();
  if (value === undefined || value === null || value === '') return null;
  if (value === 'hidden' || value === 'collapse') return false;
  if (value === 'visible') return true;
  return null;
}

/**
 * One property out of an inline `style` attribute.
 *
 * Enough CSS to answer the two questions §4.4 asks and no more. A full parser
 * would be a rabbit hole, and a `<style>` block - the case that would actually
 * need one - is reported rather than read.
 */
function inlineStyle(el: Element, property: string): string | null {
  const style = el.getAttribute('style');
  if (!style) return null;
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() !== property) continue;
    return declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase();
  }
  return null;
}

function isClipped(el: Element): boolean {
  const clip = el.getAttribute('clip-path')?.trim().toLowerCase();
  const mask = el.getAttribute('mask')?.trim().toLowerCase();
  const set = (value: string | undefined) =>
    value !== undefined && value !== '' && value !== 'none';
  return set(clip) || set(mask);
}

function groupLabel(el: Element): string | null {
  return el.localName === 'g' || el.localName === 'symbol' ? explicitLabel(el) : null;
}

/**
 * True when a `<style>` block might be hiding something.
 *
 * Illustrator emits class-based styling and hiding a layer that way is rare but
 * possible. Parsing CSS to find out is a rabbit hole with a cheap, honest
 * alternative: say that stylesheets are not read, and that shapes the drawing
 * hides may therefore appear in the list.
 */
function hidesThroughStylesheet(root: Element): boolean {
  for (const style of Array.from(root.getElementsByTagName('style'))) {
    if (/(display|visibility)\s*:/i.test(style.textContent ?? '')) return true;
  }
  return false;
}

// --- Warnings -------------------------------------------------------------

/**
 * The tally, worded.
 *
 * Ordered by how much a user needs to act on it, because the preview shows this
 * list above the commit button: things that change a part's size first, things
 * that removed something second, and the routine noise of construction lines
 * last.
 */
function materialise(tally: Tally): ImportWarning[] {
  const warnings: ImportWarning[] = [];

  if (tally.clipped > 0) warnings.push(clippedGeometry(tally.clipped));
  if (tally.sheared > 0) warnings.push(shearedShape(tally.sheared));
  if (tally.stylesheet) warnings.push(stylesheetNotRead());

  for (const [name, count] of tally.unsupported) warnings.push(unsupportedElement(name, count));
  for (const [attribute, count] of tally.badTransforms) {
    warnings.push(unparseableTransform(attribute, count));
  }

  if (tally.unparseablePaths > 0) warnings.push(unparseablePath(tally.unparseablePaths));
  if (tally.openPaths > 0) warnings.push(openPath(tally.largestGapMm, tally.openPaths));
  if (tally.cloneFailures > 0) warnings.push(cloneNotResolved(tally.cloneFailures));
  if (tally.holes > 0) warnings.push(holeDiscarded(tally.holes));
  if (tally.degenerate > 0) warnings.push(degenerateShape(tally.degenerate));

  return warnings;
}
