import { describe, expect, it } from 'vitest';
import { parseStockInstanceId, stockInstanceId } from '../../src/domain/instances';

describe('stockInstanceId', () => {
  it('numbers instances from zero in declaration order', () => {
    expect(stockInstanceId('ply18', 0)).toBe('ply18#0');
    expect(stockInstanceId('ply18', 1)).toBe('ply18#1');
    expect(stockInstanceId('ply18', 12)).toBe('ply18#12');
  });

  it('rejects an index that is not a non-negative integer', () => {
    // A caller bug, not user data, so this is the one place here that throws.
    expect(() => stockInstanceId('ply18', -1)).toThrow();
    expect(() => stockInstanceId('ply18', 1.5)).toThrow();
    expect(() => stockInstanceId('ply18', Number.NaN)).toThrow();
    expect(() => stockInstanceId('ply18', Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('parseStockInstanceId', () => {
  it('round trips every id it mints', () => {
    for (const id of ['ply18', 'mdf-12', 's', 'stock 1', 'oak/ply']) {
      for (const index of [0, 1, 7, 250]) {
        expect(parseStockInstanceId(stockInstanceId(id, index))).toEqual({ stockId: id, index });
      }
    }
  });

  it('splits at the last separator so a stock id may contain one', () => {
    // Imported or user-supplied ids are not guaranteed to avoid '#'.
    expect(parseStockInstanceId('sheet#a#3')).toEqual({ stockId: 'sheet#a', index: 3 });
    expect(parseStockInstanceId('#leading#0')).toEqual({ stockId: '#leading', index: 0 });
  });

  it('rejects anything that is not an instance id', () => {
    for (const id of ['ply18', '', 'ply18#', 'ply18#x', 'ply18#1.5', 'ply18#-1', 'ply18# 1']) {
      expect(parseStockInstanceId(id)).toBeNull();
    }
  });

  it('rejects an empty stock id', () => {
    expect(parseStockInstanceId('#0')).toBeNull();
  });

  it('rejects a non-canonical index rather than reading it loosely', () => {
    // 'ply18#007' would parse to 7 and then format back to 'ply18#7', so the
    // id would stop being a stable name for the sheet.
    expect(parseStockInstanceId('ply18#007')).toBeNull();
    expect(parseStockInstanceId('ply18#+1')).toBeNull();
  });

  it('rejects an index too large to be an exact integer', () => {
    expect(parseStockInstanceId('ply18#99999999999999999999')).toBeNull();
  });
});
