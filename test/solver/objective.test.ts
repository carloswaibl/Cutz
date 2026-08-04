import { describe, expect, it } from 'vitest';
import type { Part, Result, Stock } from '../../src/domain/types';
import {
  compareScores,
  isBetterScore,
  type SolutionScore,
  scoreResult,
} from '../../src/solver/objective';

describe('objective function', () => {
  it('minimizes unplaced part area primarily', () => {
    const better: SolutionScore = { unplacedArea: 100, usedStockArea: 5000, maxFreeRectArea: 100 };
    const worse: SolutionScore = { unplacedArea: 200, usedStockArea: 1000, maxFreeRectArea: 900 };

    expect(compareScores(better, worse)).toBeLessThan(0);
    expect(isBetterScore(better, worse)).toBe(true);
    expect(isBetterScore(worse, better)).toBe(false);
  });

  it('minimizes total used stock area secondarily', () => {
    const better: SolutionScore = { unplacedArea: 0, usedStockArea: 3000, maxFreeRectArea: 100 };
    const worse: SolutionScore = { unplacedArea: 0, usedStockArea: 6000, maxFreeRectArea: 1000 };

    expect(compareScores(better, worse)).toBeLessThan(0);
    expect(isBetterScore(better, worse)).toBe(true);
  });

  it('maximizes single largest free rectangle area as a tiebreaker', () => {
    const better: SolutionScore = { unplacedArea: 0, usedStockArea: 5000, maxFreeRectArea: 2000 };
    const worse: SolutionScore = { unplacedArea: 0, usedStockArea: 5000, maxFreeRectArea: 500 };

    expect(compareScores(better, worse)).toBeLessThan(0);
    expect(isBetterScore(better, worse)).toBe(true);
  });

  it('returns 0 for identical scores', () => {
    const score1: SolutionScore = { unplacedArea: 10, usedStockArea: 200, maxFreeRectArea: 50 };
    const score2: SolutionScore = { unplacedArea: 10, usedStockArea: 200, maxFreeRectArea: 50 };

    expect(compareScores(score1, score2)).toBe(0);
    expect(isBetterScore(score1, score2)).toBe(false);
  });

  it('scores a domain Result correctly', () => {
    const parts: Part[] = [
      {
        id: 'p1',
        label: 'Panel',
        width: 100,
        height: 200,
        qty: 3,
        materialId: 'm1',
        rotationPolicy: 'free90',
      },
    ];
    const stock: Stock[] = [
      { id: 's1', materialId: 'm1', width: 1000, height: 1000, qty: 2, grainAxis: 'x' },
    ];

    const result: Result = {
      layouts: [
        { stockInstanceId: 's1#0', placements: [], wastePct: 0.1 },
        { stockInstanceId: 's1#1', placements: [], wastePct: 0.1 },
      ],
      unplacedParts: [{ partId: 'p1', qty: 1 }],
      totalWastePct: 0.1,
    };

    const score = scoreResult(result, parts, stock);
    expect(score.unplacedArea).toBe(100 * 200 * 1); // 20000
    expect(score.usedStockArea).toBe(1000 * 1000 * 2); // 2000000
  });
});
