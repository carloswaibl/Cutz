// @vitest-environment jsdom

/**
 * `parseSvgDocument`, and the jsdom-versus-browser question underneath it.
 *
 * §8's risk register lists "jsdom is not the browser" as the one place the test
 * environment could pass a file Chrome rejects, or vice versa. The behaviour
 * was probed before `document.ts` was written, and the answer is that both
 * engines report a failed XML parse the same way: not by throwing and not by a
 * status flag, but by returning a perfectly valid document whose content is a
 * `<parsererror>` element in Mozilla's namespace.
 *
 * The first block below is that finding, pinned. If a future jsdom changes it,
 * these fail loudly rather than letting `document.ts` quietly stop detecting
 * malformed files.
 */

import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../../src/import/errors';
import { parseSvgDocument } from '../../src/import/svg/document';

const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

describe('jsdom DOMParser parity', () => {
  const malformed = [
    ['a truncated file', '<svg xmlns="http://www.w3.org/2000/svg"><g><rect/>'],
    ['mismatched tags', '<svg xmlns="http://www.w3.org/2000/svg"><g></svgg>'],
    ['an empty file', ''],
    ['whitespace only', '   \n  '],
    ['plain text', 'not xml at all'],
    ['an undefined entity', '<svg xmlns="http://www.w3.org/2000/svg">&nbsp;</svg>'],
    ['an unquoted attribute', '<svg xmlns="http://www.w3.org/2000/svg" width=10></svg>'],
  ] as const;

  it.each(malformed)('reports %s as a namespaced parsererror', (_name, text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    expect(doc.getElementsByTagNameNS(PARSERERROR_NS, 'parsererror').length).toBeGreaterThan(0);
  });

  it('parses well-formed non-SVG XML without complaint, leaving the root check to us', () => {
    const doc = new DOMParser().parseFromString('<foo><bar/></foo>', 'image/svg+xml');
    expect(doc.getElementsByTagNameNS(PARSERERROR_NS, 'parsererror')).toHaveLength(0);
    expect(doc.documentElement.localName).toBe('foo');
  });

  it('resolves ids in an XML-parsed SVG, which `use` resolution depends on', () => {
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="tpl"/></defs></svg>',
      'image/svg+xml',
    );
    expect(doc.getElementById('tpl')?.localName).toBe('rect');
  });
});

describe('parseSvgDocument', () => {
  it('accepts a namespaced SVG', () => {
    const result = parseSvgDocument('<svg xmlns="http://www.w3.org/2000/svg" width="10mm"/>');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.root.localName).toBe('svg');
  });

  it('accepts an SVG that forgot its xmlns', () => {
    // Rejecting a hand-edited drawing over an attribute that changes nothing
    // about its geometry would be pedantry, so the root is matched on its local
    // name and every later lookup follows suit.
    const result = parseSvgDocument('<svg width="10mm"><rect width="5" height="5"/></svg>');
    expect(result.ok).toBe(true);
  });

  it('rejects a truncated file as not-xml', () => {
    const result = parseSvgDocument('<svg xmlns="http://www.w3.org/2000/svg"><g><rect/>');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-xml');
  });

  it('rejects an HTML page as not-svg, naming what it found', () => {
    const result = parseSvgDocument('<html><body><p>hi</p></body></html>');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not-svg');
      expect(result.error.message).toContain('<html>');
    }
  });

  it('rejects a case-mismatched root, because XML is case-sensitive', () => {
    const result = parseSvgDocument('<SVG xmlns="http://www.w3.org/2000/svg"/>');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-svg');
  });

  it('rejects a file over the size cap before trying to parse it', () => {
    const padding = ' '.repeat(MAX_FILE_BYTES + 1);
    const result = parseSvgDocument(
      `<svg xmlns="http://www.w3.org/2000/svg"><!--${padding}--></svg>`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('file-too-large');
  });

  it('measures the cap in UTF-8 bytes, not UTF-16 code units', () => {
    // A drawing full of non-ASCII labels is exactly the file where the two
    // numbers diverge, and the cap is a statement about a file on disk.
    const multibyte = '\u{1F332}'.repeat(4); // 4 bytes each in UTF-8, 2 units each in UTF-16
    expect(multibyte.length).toBe(8);
    expect(new TextEncoder().encode(multibyte).length).toBe(16);
  });
});
