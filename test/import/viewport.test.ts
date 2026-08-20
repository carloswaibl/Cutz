// @vitest-environment jsdom

/**
 * Unit and viewport resolution - §5.1, and the highest-stakes arithmetic in the
 * milestone.
 *
 * Every other failure the importer can have is visible. A wrong scale produces
 * a complete parts list of believable numbers and surfaces after a sheet has
 * been cut, so these tests check the *number*, not just that something came out.
 */

import { describe, expect, it } from 'vitest';
import { applyMatrix } from '../../src/import/svg/transform';
import {
  parseAspectRatio,
  parseSvgLength,
  parseViewBox,
  resolveViewport,
} from '../../src/import/svg/viewport';

const MM_PER_PX = 25.4 / 96;

function root(attributes: string): Element {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}/>`,
    'image/svg+xml',
  );
  return doc.documentElement;
}

describe('parseSvgLength', () => {
  it.each([
    ['210mm', 210, 'mm'],
    ['8.5in', 8.5, 'in'],
    ['  1e3px  ', 1000, 'px'],
    ['.5', 0.5, ''],
    ['-12.25CM', -12.25, 'cm'],
    ['100%', 100, '%'],
  ])('reads %s', (text, value, unit) => {
    expect(parseSvgLength(text)).toEqual({ value, unit });
  });

  it.each(['', 'auto', 'calc(100% - 4px)', '10 20', null])('rejects %s', (text) => {
    expect(parseSvgLength(text)).toBeNull();
  });
});

describe('parseViewBox', () => {
  it('accepts comma or space separators and a negative origin', () => {
    expect(parseViewBox('-16, -90.64 2472 1326.64')).toEqual({
      minX: -16,
      minY: -90.64,
      width: 2472,
      height: 1326.64,
    });
  });

  it.each(['0 0 100', '0 0 100 0', '0 0 -5 5', 'a b c d', null])('rejects %s', (text) => {
    expect(parseViewBox(text)).toBeNull();
  });
});

describe('parseAspectRatio', () => {
  it('defaults to xMidYMid meet when the attribute is absent', () => {
    expect(parseAspectRatio(null)).toEqual({ alignX: 0.5, alignY: 0.5, slice: false });
  });

  it('reads none, and the slice keyword', () => {
    expect(parseAspectRatio('none')).toEqual({ alignX: null, alignY: 0, slice: false });
    expect(parseAspectRatio('xMinYMax slice')).toEqual({ alignX: 0, alignY: 1, slice: true });
  });

  it('ignores a leading defer, which is only meaningful on an image', () => {
    expect(parseAspectRatio('defer xMaxYMin meet')).toEqual({
      alignX: 1,
      alignY: 0,
      slice: false,
    });
  });

  it('falls back to the default on a value it cannot read', () => {
    // Unlike a transform, where a wrong answer moves a part somewhere arbitrary,
    // the default here is what the file would have got by saying nothing.
    expect(parseAspectRatio('sideways')).toEqual({ alignX: 0.5, alignY: 0.5, slice: false });
  });
});

describe('resolveViewport', () => {
  it('declared width with a viewBox is the happy path: mm per unit is the ratio', () => {
    // Inkscape 1.x's normal A4 output. 210mm across 210 user units is 1:1.
    const viewport = resolveViewport(root('width="210mm" height="297mm" viewBox="0 0 210 297"'));
    expect(viewport.scale).toEqual({ kind: 'declared', unit: 'mm', mmPerUnit: 1 });
    expect(viewport.drawingWidthMm).toBeCloseTo(210, 10);
    expect(viewport.drawingHeightMm).toBeCloseTo(297, 10);
  });

  it('scales up when the viewBox is smaller than the declared size', () => {
    const viewport = resolveViewport(root('width="100mm" height="50mm" viewBox="0 0 10 5"'));
    expect(viewport.scale.kind).toBe('declared');
    expect(viewport.matrix.a).toBeCloseTo(10, 10);
    expect(applyMatrix(viewport.matrix, { x: 10, y: 5 })).toEqual({ x: 100, y: 50 });
  });

  it('takes user units as the declared unit when there is no viewBox', () => {
    const viewport = resolveViewport(root('width="8in" height="4in"'));
    expect(viewport.scale).toEqual({ kind: 'declared', unit: 'in', mmPerUnit: 25.4 });
    expect(viewport.drawingWidthMm).toBeCloseTo(203.2, 10);
  });

  it.each([
    ['pt', 25.4 / 72],
    ['pc', 25.4 / 6],
    ['cm', 10],
    ['q', 0.25],
  ])('knows %s is %f mm', (unit, mm) => {
    const viewport = resolveViewport(root(`width="1${unit}" height="1${unit}"`));
    expect(viewport.scale.kind).toBe('declared');
    expect(viewport.matrix.a).toBeCloseTo(mm, 12);
  });

  it('labels a unitless document as assumed-px rather than declared', () => {
    // The spec defines a px as 1/96in so a scale *is* derivable, but Inkscape
    // before 0.92 used 90dpi and those files are still in the wild. The
    // difference between this and `declared` is the whole units policy.
    const viewport = resolveViewport(root('width="800" height="600" viewBox="0 0 800 600"'));
    expect(viewport.scale).toEqual({ kind: 'assumed-px', mmPerUnit: MM_PER_PX });
    expect(viewport.drawingWidthMm).toBeCloseTo(800 * MM_PER_PX, 10);
  });

  it('treats an explicit px the same as unitless', () => {
    const viewport = resolveViewport(root('width="96px" height="96px"'));
    expect(viewport.scale).toEqual({ kind: 'assumed-px', mmPerUnit: MM_PER_PX });
    expect(viewport.drawingWidthMm).toBeCloseTo(25.4, 10);
  });

  it.each([
    ['percentage dimensions', 'width="100%" height="100%" viewBox="0 0 10 10"'],
    ['a viewBox and no dimensions', 'viewBox="0 0 10 10"'],
    ['nothing at all', ''],
  ])('blocks import on %s', (_name, attributes) => {
    const viewport = resolveViewport(root(attributes));
    expect(viewport.scale).toEqual({ kind: 'none' });
    expect(viewport.drawingWidthMm).toBeNull();
    expect(viewport.drawingHeightMm).toBeNull();
  });

  it('keeps the viewBox origin shift even when the scale is unknown', () => {
    // Relative geometry stays right for a preview the user is about to supply
    // the missing factor to.
    const viewport = resolveViewport(root('viewBox="-16 -90.64 2472 1326.64"'));
    expect(viewport.scale.kind).toBe('none');
    expect(applyMatrix(viewport.matrix, { x: -16, y: -90.64 })).toEqual({ x: 0, y: 0 });
  });

  it('shifts a non-zero viewBox origin to the top-left', () => {
    const viewport = resolveViewport(root('width="2472mm" viewBox="-16 -90.64 2472 1326.64"'));
    expect(viewport.matrix.a).toBeCloseTo(1, 12);
    const origin = applyMatrix(viewport.matrix, { x: -16, y: -90.64 });
    expect(origin.x).toBeCloseTo(0, 10);
    expect(origin.y).toBeCloseTo(0, 10);
  });

  describe('preserveAspectRatio', () => {
    // A 100x100mm viewport showing a 200x100 viewBox. sx would be 0.5 and sy
    // would be 1.0; taking sx alone is right by luck here, taking sy alone
    // stretches every part 2x in one axis.
    const mismatched = 'width="100mm" height="100mm" viewBox="0 0 200 100"';

    it('uses a uniform min(sx, sy) by default, not the x scale alone', () => {
      const viewport = resolveViewport(root(mismatched));
      expect(viewport.matrix.a).toBeCloseTo(0.5, 12);
      expect(viewport.matrix.d).toBeCloseTo(0.5, 12);
    });

    it('centres the fitted drawing for the default xMidYMid', () => {
      const viewport = resolveViewport(root(mismatched));
      // 100mm of viewport, 50mm of drawing height, so 25mm of slack above.
      expect(viewport.matrix.f).toBeCloseTo(25, 10);
      expect(viewport.matrix.e).toBeCloseTo(0, 10);
    });

    it('honours xMinYMin by not centring at all', () => {
      const viewport = resolveViewport(root(`${mismatched} preserveAspectRatio="xMinYMin"`));
      expect(viewport.matrix.e).toBeCloseTo(0, 10);
      expect(viewport.matrix.f).toBeCloseTo(0, 10);
    });

    it('honours none as the anisotropic case it is', () => {
      const viewport = resolveViewport(root(`${mismatched} preserveAspectRatio="none"`));
      expect(viewport.matrix.a).toBeCloseTo(0.5, 12);
      expect(viewport.matrix.d).toBeCloseTo(1, 12);
    });

    it('fits a slice request instead of cropping, and says so', () => {
      const viewport = resolveViewport(root(`${mismatched} preserveAspectRatio="xMidYMid slice"`));
      expect(viewport.warnings.map((w) => w.kind)).toEqual(['slice-aspect']);
      expect(viewport.matrix.a).toBeCloseTo(0.5, 12);
    });

    it('leaves a matched aspect alone', () => {
      const viewport = resolveViewport(root('width="200mm" height="100mm" viewBox="0 0 200 100"'));
      expect(viewport.matrix.a).toBeCloseTo(1, 12);
      expect(viewport.matrix.e).toBeCloseTo(0, 10);
      expect(viewport.matrix.f).toBeCloseTo(0, 10);
    });
  });

  describe('the scale override', () => {
    it('rescales rather than replaces, keeping the viewBox origin', () => {
      const viewport = resolveViewport(root('width="100mm" viewBox="10 10 100 100"'), 2);
      expect(viewport.scale).toEqual({ kind: 'user', mmPerUnit: 2 });
      // The origin still lands at 0,0 - the shift scaled along with everything.
      const origin = applyMatrix(viewport.matrix, { x: 10, y: 10 });
      expect(origin.x).toBeCloseTo(0, 10);
      expect(origin.y).toBeCloseTo(0, 10);
      expect(applyMatrix(viewport.matrix, { x: 110, y: 110 }).x).toBeCloseTo(200, 10);
    });

    it('preserves deliberate anisotropy', () => {
      const viewport = resolveViewport(
        root('width="100mm" height="100mm" viewBox="0 0 200 100" preserveAspectRatio="none"'),
        1,
      );
      // x was 0.5 and y was 1.0; forcing x to 1 doubles both.
      expect(viewport.matrix.a).toBeCloseTo(1, 12);
      expect(viewport.matrix.d).toBeCloseTo(2, 12);
    });

    it('establishes a scale for a document that had none', () => {
      const viewport = resolveViewport(root('viewBox="0 0 100 100"'), 3);
      expect(viewport.scale).toEqual({ kind: 'user', mmPerUnit: 3 });
      expect(viewport.drawingWidthMm).toBeCloseTo(300, 10);
    });

    it('ignores a nonsensical override rather than scaling by zero', () => {
      const viewport = resolveViewport(root('width="210mm" viewBox="0 0 210 297"'), 0);
      expect(viewport.scale.kind).toBe('declared');
    });
  });

  it('ignores the Inkscape ruler hints, which describe the editor not the document', () => {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg"
            xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
            inkscape:document-units="in" width="210mm" viewBox="0 0 210 297"/>`,
      'image/svg+xml',
    );
    const viewport = resolveViewport(doc.documentElement);
    expect(viewport.scale).toEqual({ kind: 'declared', unit: 'mm', mmPerUnit: 1 });
  });
});
