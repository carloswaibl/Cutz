import { describe, expect, it } from 'vitest';
import {
  clippedGeometry,
  cloneNotResolved,
  degenerateShape,
  emptyDrawing,
  fileTooLarge,
  holeDiscarded,
  MAX_FILE_BYTES,
  MAX_SHAPES,
  MAX_USE_DEPTH,
  notSvg,
  notXml,
  openPath,
  shearedShape,
  sizeSpread,
  sliceAspect,
  stylesheetNotRead,
  tooManyShapes,
  unparseablePath,
  unparseableTransform,
  unsupportedElement,
} from '../../src/import/errors';
import type { ImportWarning } from '../../src/import/types';

const everyWarning = (count: number): ImportWarning[] => [
  unsupportedElement('text', count),
  clippedGeometry(count),
  stylesheetNotRead(),
  degenerateShape(count),
  openPath(4.2, count),
  unparseablePath(count),
  holeDiscarded(count),
  shearedShape(count),
  sizeSpread(0.4, count),
  sliceAspect(),
  unparseableTransform('matrix(1,0,0)', count),
  cloneNotResolved(count),
];

const everyError = [
  fileTooLarge(42 * 1024 * 1024),
  notXml(),
  notSvg('html'),
  tooManyShapes(),
  emptyDrawing(),
];

describe('every message', () => {
  it('says something, and says it as a sentence', () => {
    for (const { message } of [...everyWarning(3), ...everyError]) {
      expect(message.length).toBeGreaterThan(40);
      expect(message.endsWith('.')).toBe(true);
      expect(message).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it('agrees with itself about number, singular and plural', () => {
    // "1 shapes were skipped" reads as a bug in the app, which makes a user
    // trust the number less than they should.
    for (const { message } of everyWarning(1)) {
      expect(message).not.toMatch(/\bwere\b/);
      expect(message).not.toMatch(/^1 \w+s\b/);
    }
    for (const { message } of everyWarning(4)) {
      expect(message).not.toMatch(/\b4 \w+ was\b/);
    }
  });

  it('carries the count it was built with', () => {
    for (const warning of everyWarning(7)) {
      // The two that stand for a document-wide fact are always one occurrence.
      const expected = warning.kind === 'stylesheet-not-read' || warning.kind === 'slice-aspect';
      expect(warning.count).toBe(expected ? 1 : 7);
    }
  });
});

describe('naming the thing that went wrong', () => {
  it('names the element that was skipped, not just its category', () => {
    // Folding on the kind alone would report "8 unsupported elements" and lose
    // the fact that three were text and five were images.
    expect(unsupportedElement('text', 3).message).toContain('<text>');
    expect(unsupportedElement('foreignObject', 1).message).toContain('<foreignObject>');
    expect(unsupportedElement('text', 3).message).not.toBe(unsupportedElement('image', 3).message);
  });

  it('quotes the transform it could not read', () => {
    expect(unparseableTransform('matrix(1,0,0)', 1).message).toContain('"matrix(1,0,0)"');
  });

  it('gives the gap size, which is what locates an open path', () => {
    expect(openPath(4.2, 1).message).toContain('4.2mm');
    expect(openPath(4.20001, 1).message).toContain('4.2mm');
    expect(openPath(0.5, 1).message).toContain('0.5mm');
  });

  it('gives the size disagreement inside a grouped row', () => {
    expect(sizeSpread(0.35, 2).message).toContain('0.35mm');
  });

  it('names the root element that was found instead of svg', () => {
    expect(notSvg('html').message).toContain('<html>');
  });

  it('quotes the caps it enforces, so the number and the message cannot drift', () => {
    expect(fileTooLarge(42 * 1024 * 1024).message).toContain('42MB');
    expect(fileTooLarge(42 * 1024 * 1024).message).toContain(`${MAX_FILE_BYTES / (1024 * 1024)}MB`);
    expect(tooManyShapes().message).toContain(String(MAX_SHAPES));
    expect(cloneNotResolved(1).message).toContain(String(MAX_USE_DEPTH));
  });
});

describe('telling the user what to do', () => {
  it('warns that clipped geometry imports larger than it looks', () => {
    // The one warning where believing the screen instead of the message gets a
    // part cut wrong.
    expect(clippedGeometry(2).message).toMatch(/larger|unclipped/);
  });

  it('says a sheared part imports oversized', () => {
    expect(shearedShape(1).message).toMatch(/oversized|bigger/);
  });

  it('says a grouped row takes the largest of its shapes', () => {
    // The direction matters: a part that imports smaller than drawn does not
    // fit, one that imports larger does.
    expect(sizeSpread(0.4, 1).message).toContain('largest');
  });

  it('points at hidden layers when a drawing looks empty', () => {
    expect(emptyDrawing().message).toContain('hidden');
  });
});
