/**
 * What to call an imported part.
 *
 * A cut list whose rows read `Part 1` through `Part 14` is a cut list somebody
 * has to cross-reference against their drawing by size, at the saw, with
 * sawdust on the page. Every editor already stores a name somewhere; the work
 * is knowing where each one puts it and which of those names is worth showing.
 *
 * Every label is editable in the preview, so a wrong guess costs a keystroke.
 * A *machine-generated* guess costs more than that, because `path1234` looks
 * enough like a name that a user may not realise the real one was available -
 * which is why `id` is filtered rather than trusted.
 */

export interface LabelContext {
  /** Enclosing layer or group name, when one was found. */
  layerName: string | null;
  /** 1-based position among the shapes taken from this document. */
  index: number;
}

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';

/**
 * Ids that editors generate rather than people writing.
 *
 * Anchored and prefixed with real element and generator names rather than the
 * looser `letters followed by digits`, which would also reject `Shelf1` - a
 * name somebody plainly chose. Being conservative here is the right direction
 * to be wrong in: a machine id that slips through is visible and editable, a
 * real name that gets filtered is silently gone.
 */
const GENERATED_ID =
  /^(?:path|rect|circle|ellipse|polygon|polyline|line|g|use|svg|defs|text|tspan|layer|group|clip|clippath|mask|image|symbol|marker|xmlid)[-_ ]?\d+_?$/i;

/**
 * Illustrator escapes anything outside a narrow character set as `_xHHHH_`, so
 * `Shelf_x20_Side` is `Shelf Side` and `_x5F_` is a literal underscore.
 * Decoding is what turns Illustrator's ids from noise into names.
 */
const ILLUSTRATOR_ESCAPE = /_x([0-9A-Fa-f]{1,6})_/g;

export function decodeIllustratorEscapes(text: string): string {
  return text.replace(ILLUSTRATOR_ESCAPE, (whole, hex: string) => {
    const code = Number.parseInt(hex, 16);
    // A lone `_x110000_` is not an escape, it is somebody's name. Leaving it
    // alone beats throwing.
    if (!Number.isFinite(code) || code > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

/**
 * The best name this element can offer, in the order the sources deserve.
 *
 * `<title>` first because it is the only one of these that exists purely to be
 * a human-readable name - SVG's own accessible-name mechanism, and what
 * Inkscape's Object Properties dialog writes. `id` last of the real sources
 * because it is the one an editor will have filled in whether the user wanted
 * it or not.
 */
export function labelFor(el: Element, ctx: LabelContext): string {
  const explicit = explicitLabel(el);
  if (explicit) return explicit;

  // The layer's name plus a position is still better than a bare number: it
  // tells the user which part of their drawing to go looking in.
  if (ctx.layerName) return `${ctx.layerName} ${ctx.index}`;

  return `Part ${ctx.index}`;
}

/**
 * A name this element actually carries, or null when it has none worth using.
 *
 * Split out from `labelFor` because two callers need to know the difference
 * between a real name and a positional fallback: a `use` only overrides its
 * template's name when it has one of its own, and a group only becomes a layer
 * name when somebody named it.
 */
export function explicitLabel(el: Element): string | null {
  const title = directTitle(el);
  if (title) return title;

  const inkscapeLabel = clean(
    el.getAttributeNS(INKSCAPE_NS, 'label') ?? el.getAttribute('inkscape:label'),
  );
  if (inkscapeLabel) return inkscapeLabel;

  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;

  const id = clean(el.getAttribute('id'));
  if (id && !GENERATED_ID.test(id)) return decodeIllustratorEscapes(id);

  return null;
}

/**
 * The element's own `<title>`, not a descendant's.
 *
 * A `<g>` containing three shapes that each have a title would otherwise take
 * the first child shape's name for the group, which is a different part's name.
 */
function directTitle(el: Element): string | null {
  for (const child of Array.from(el.children)) {
    if (child.localName === 'title') return clean(child.textContent);
  }
  return null;
}

function clean(text: string | null): string | null {
  if (text === null) return null;
  // Editors wrap and indent freely, and a label carrying a newline breaks every
  // table it lands in.
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}
