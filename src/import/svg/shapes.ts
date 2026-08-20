/**
 * The basic shapes, as path data.
 *
 * An adapter, not a conversion module. `svg-pathdata` ships `SVGShapes` with
 * the four constructions this needs, and they are the fiddly ones - a rounded
 * rect's corner arcs and an ellipse's four-arc decomposition are both easy to
 * write slightly wrong in a way that only shows up on one shape in one file.
 * So the work here is reading attributes and rejecting the ones that do not say
 * what they appear to.
 *
 * Everything comes out as a `d` string in *user units*. The transform to
 * millimetres is applied later, in `flatten.ts`, because the flattening
 * tolerance is a physical distance and has to be applied to physical
 * coordinates.
 */

import { SVGShapes } from 'svg-pathdata';
import { parseSvgLength } from './viewport';

/**
 * `line` is here even though it can never produce a part.
 *
 * Converting it to a two-point polyline and letting the existing degenerate
 * test reject it is one code path instead of two, and it lands the line in
 * §4.3's counted `degenerate-shape` fold - which is what a user wants for the
 * construction lines and registration marks that make up almost every real
 * instance of it. Special-casing it here would need its own warning and its own
 * counting, for a worse result.
 */
const SHAPE_ELEMENTS: ReadonlySet<string> = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
  'line',
]);

export function isShapeElement(localName: string): boolean {
  return SHAPE_ELEMENTS.has(localName);
}

/**
 * One shape element as path data, or null when its geometry could not be read.
 *
 * Null is a reportable fact about the file - the caller names the element in an
 * `unparseable-path` warning and carries on with the rest of the drawing. It is
 * never an empty path, because an empty path is a shape that silently is not
 * there.
 */
export function shapeToPathData(el: Element): string | null {
  switch (el.localName) {
    case 'path': {
      const d = el.getAttribute('d');
      return d !== null && d.trim() !== '' ? d : null;
    }

    case 'rect': {
      const x = coord(el, 'x') ?? 0;
      const y = coord(el, 'y') ?? 0;
      const width = coord(el, 'width');
      const height = coord(el, 'height');
      if (width === null || height === null || width <= 0 || height <= 0) return null;

      // Per the spec, one radius given implies the other. The clamp to half the
      // side is the spec's too, and it is what stops `rx="9999"` describing a
      // shape with inside-out corners.
      const rxAttr = el.hasAttribute('rx') ? coord(el, 'rx') : null;
      const ryAttr = el.hasAttribute('ry') ? coord(el, 'ry') : null;
      const rx = Math.min(Math.max(rxAttr ?? ryAttr ?? 0, 0), width / 2);
      const ry = Math.min(Math.max(ryAttr ?? rxAttr ?? 0, 0), height / 2);

      return SVGShapes.createRect(x, y, width, height, rx, ry).encode();
    }

    case 'circle': {
      const r = coord(el, 'r');
      if (r === null || r <= 0) return null;
      return SVGShapes.createEllipse(r, r, coord(el, 'cx') ?? 0, coord(el, 'cy') ?? 0).encode();
    }

    case 'ellipse': {
      const rx = coord(el, 'rx');
      const ry = coord(el, 'ry');
      if (rx === null || ry === null || rx <= 0 || ry <= 0) return null;
      return SVGShapes.createEllipse(rx, ry, coord(el, 'cx') ?? 0, coord(el, 'cy') ?? 0).encode();
    }

    case 'polygon': {
      const points = coordList(el.getAttribute('points'));
      return points ? SVGShapes.createPolygon(points).encode() : null;
    }

    case 'polyline': {
      const points = coordList(el.getAttribute('points'));
      return points ? SVGShapes.createPolyline(points).encode() : null;
    }

    case 'line': {
      const x1 = coord(el, 'x1') ?? 0;
      const y1 = coord(el, 'y1') ?? 0;
      const x2 = coord(el, 'x2') ?? 0;
      const y2 = coord(el, 'y2') ?? 0;
      return SVGShapes.createPolyline([x1, y1, x2, y2]).encode();
    }

    default:
      return null;
  }
}

/**
 * A geometry attribute in user units, or null when it is absent or does not
 * describe one.
 *
 * SVG 1.1 allows a unit on these - `<rect width="10mm">` is legal - and there
 * is no honest way to read it here, because converting it needs the
 * millimetres-per-user-unit factor that only the viewport knows. Rather than
 * treat `10mm` as ten user units, which would import a 10mm part at whatever
 * ten units happens to be, an unexpected unit returns null and the shape is
 * reported as unreadable. `px` is accepted alongside no unit at all because in
 * SVG they are the same thing: the user coordinate system's unit *is* the px.
 */
export function coord(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null) return null;
  const length = parseSvgLength(raw);
  if (!length) return null;
  if (length.unit !== '' && length.unit !== 'px') return null;
  return length.value;
}

/**
 * A `points` attribute as a flat coordinate list.
 *
 * Null unless it is an even number of readable numbers describing at least two
 * points. A trailing odd coordinate means the attribute was truncated, and the
 * shape it describes is not the shape the author drew.
 */
function coordList(text: string | null): number[] | null {
  if (text === null) return null;
  const tokens = text
    .trim()
    .split(/[\s,]+/)
    .filter((token) => token !== '');
  if (tokens.length < 4 || tokens.length % 2 !== 0) return null;
  const numbers = tokens.map(Number);
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  return numbers;
}
