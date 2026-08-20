// @vitest-environment jsdom

/** Part naming - §5.7. */

import { describe, expect, it } from 'vitest';
import { decodeIllustratorEscapes, explicitLabel, labelFor } from '../../src/import/svg/label';

function element(markup: string): Element {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg"
          xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">${markup}</svg>`,
    'image/svg+xml',
  );
  const first = doc.documentElement.children[0];
  if (!first) throw new Error('no element in test markup');
  return first;
}

const anywhere = { layerName: null, index: 1 };

describe('decodeIllustratorEscapes', () => {
  it('decodes a space', () => {
    expect(decodeIllustratorEscapes('Shelf_x20_Side')).toBe('Shelf Side');
  });

  it('decodes a literal underscore', () => {
    expect(decodeIllustratorEscapes('Left_x5F_Panel')).toBe('Left_Panel');
  });

  it('leaves something that only looks like an escape alone', () => {
    expect(decodeIllustratorEscapes('shelf_side')).toBe('shelf_side');
    expect(decodeIllustratorEscapes('_x110000_')).toBe('_x110000_');
  });
});

describe('labelFor', () => {
  it('prefers a title child', () => {
    expect(labelFor(element('<rect id="realname"><title>Top Shelf</title></rect>'), anywhere)).toBe(
      'Top Shelf',
    );
  });

  it("does not take a descendant's title for a group", () => {
    // Otherwise a `<g>` of three named shapes takes the first one's name, which
    // is a different part's name.
    const g = element('<g><rect><title>Top Shelf</title></rect></g>');
    expect(labelFor(g, { layerName: null, index: 4 })).toBe('Part 4');
  });

  it('falls back to inkscape:label', () => {
    expect(labelFor(element('<rect inkscape:label="Side Panel"/>'), anywhere)).toBe('Side Panel');
  });

  it('falls back to aria-label', () => {
    expect(labelFor(element('<rect aria-label="Back"/>'), anywhere)).toBe('Back');
  });

  it('uses an id that looks like a name', () => {
    expect(labelFor(element('<rect id="Shelf_x20_Side"/>'), anywhere)).toBe('Shelf Side');
  });

  it('keeps a name that merely ends in a digit', () => {
    // `^[a-z]+\d+$` would reject this, and a real name silently going missing
    // is worse than a machine id slipping through - the latter is visible and
    // editable in the preview.
    expect(labelFor(element('<rect id="Shelf1"/>'), anywhere)).toBe('Shelf1');
  });

  it.each(['path1234', 'rect27', 'g-12', 'Layer_1', 'XMLID_44_', 'polyline9'])(
    'refuses the machine-generated id %s',
    (id) => {
      expect(labelFor(element(`<rect id="${id}"/>`), { layerName: null, index: 7 })).toBe('Part 7');
    },
  );

  it('names a shape after its layer when it has nothing of its own', () => {
    expect(labelFor(element('<rect/>'), { layerName: 'Shelves', index: 3 })).toBe('Shelves 3');
  });

  it('falls back to a numbered part', () => {
    expect(labelFor(element('<rect/>'), { layerName: null, index: 12 })).toBe('Part 12');
  });

  it('collapses whitespace so a label cannot break the table it lands in', () => {
    expect(labelFor(element('<rect><title>  Top\n   Shelf </title></rect>'), anywhere)).toBe(
      'Top Shelf',
    );
  });

  it('treats an empty title as absent', () => {
    expect(
      labelFor(element('<rect><title>   </title></rect>'), { layerName: null, index: 2 }),
    ).toBe('Part 2');
  });
});

describe('explicitLabel', () => {
  it('is null when the element carries no name of its own', () => {
    expect(explicitLabel(element('<rect id="path99"/>'))).toBeNull();
  });

  it('is the name when it has one, with no positional fallback', () => {
    expect(explicitLabel(element('<g inkscape:label="Carcass"/>'))).toBe('Carcass');
  });
});
