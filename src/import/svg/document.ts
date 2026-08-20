/**
 * Text to a parsed SVG root, or a typed reason why not.
 *
 * The three guards here are the only thing standing between an arbitrary file
 * off somebody's disk and the rest of the importer, so each one answers a
 * question the caller would otherwise have to guess at: is this small enough to
 * parse at all, did it parse, and is it an SVG.
 *
 * `DOMParser` is this layer's one sanctioned browser dependency - the whole
 * point of using the platform's XML parser is that it is the same parser the
 * user's editor validated the file against. Tests run it under jsdom, whose
 * behaviour on malformed input was checked against the browser's before this
 * file was written; `test/import/document.test.ts` pins what was found.
 */

import { fileTooLarge, type ImportError, MAX_FILE_BYTES, notSvg, notXml } from '../errors';

export type DocumentParse = { ok: true; root: Element } | { ok: false; error: ImportError };

/**
 * Where every engine puts its "this is not well-formed XML" report.
 *
 * Mozilla invented it and everyone else copied it, so Chrome, Firefox, WebKit
 * and jsdom all agree. There is no exception thrown and no status flag - a
 * failed XML parse comes back as a perfectly valid document describing the
 * failure, which is why this has to be looked for explicitly rather than
 * trusted to surface itself.
 */
const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

/**
 * Parse `text` as SVG.
 *
 * Deliberately lenient about the SVG namespace and strict about everything
 * else. A file whose root is `<svg>` but which forgot `xmlns` is a file a
 * person hand-edited, and rejecting their drawing over a missing attribute that
 * changes nothing about the geometry would be pedantry - so the root is matched
 * on its local name. Every later lookup follows suit and uses `localName`
 * rather than a namespaced query, which is what makes that leniency actually
 * hold up past this function.
 */
export function parseSvgDocument(text: string): DocumentParse {
  const bytes = utf8Length(text);
  if (bytes > MAX_FILE_BYTES) return { ok: false, error: fileTooLarge(bytes) };

  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (hasParserError(doc)) return { ok: false, error: notXml() };

  const root = doc.documentElement;
  // An empty or whitespace-only file parses to a `parsererror` in every engine
  // checked, so a null root here is belt and braces rather than a known case.
  if (!root) return { ok: false, error: notXml() };

  // XML is case-sensitive and the SVG spec is lowercase, so a `<SVG>` root is
  // not an SVG root. It falls through to the same message, which names what was
  // actually found and is therefore still accurate.
  if (root.localName !== 'svg') return { ok: false, error: notSvg(root.localName) };

  return { ok: true, root };
}

/**
 * True when the parse failed.
 *
 * Searched for across the whole document rather than only at the root. Firefox
 * and jsdom replace the entire document with a `parsererror`; Chrome sometimes
 * nests one inside the partially-parsed tree instead. Checking only the root
 * would pass a truncated file through as a half-drawing on the engine that
 * matters most.
 */
function hasParserError(doc: Document): boolean {
  if (doc.getElementsByTagNameNS(PARSERERROR_NS, 'parsererror').length > 0) return true;
  // A last resort for an engine that reports the failure without the namespace.
  return doc.documentElement?.localName === 'parsererror';
}

/**
 * The file's size in bytes, not the string's length in UTF-16 code units.
 *
 * The cap is a statement about a file on disk, and the two numbers diverge on
 * exactly the files most likely to be near it - a drawing full of non-ASCII
 * labels. Encoding a large string to measure it is not free, but the string is
 * already in memory by the time this runs, so it costs a constant factor rather
 * than an order of magnitude.
 */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
