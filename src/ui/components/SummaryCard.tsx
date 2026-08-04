import { useMemo } from 'react';
import { parseStockInstanceId } from '../../domain/instances';
import type { Material, Part, Result, Stock } from '../../domain/types';

interface SummaryCardProps {
  result: Result;
  parts: Part[];
  materials: Material[];
  stock: Stock[];
}

export function SummaryCard({ result, parts, materials, stock }: SummaryCardProps) {
  const { totalParts, placedParts, unplacedPartsCount } = useMemo(() => {
    let total = 0;
    for (const p of parts) total += p.qty;
    let unplaced = 0;
    for (const u of result.unplacedParts) unplaced += u.qty;
    return {
      totalParts: total,
      placedParts: total - unplaced,
      unplacedPartsCount: unplaced,
    };
  }, [parts, result.unplacedParts]);

  const wastePct = (result.totalWastePct * 100).toFixed(1);
  const wasteColor =
    result.totalWastePct < 0.1
      ? 'text-emerald-400 bg-emerald-400/10 border-emerald-500/20'
      : result.totalWastePct < 0.2
        ? 'text-amber-400 bg-amber-400/10 border-amber-500/20'
        : 'text-red-400 bg-red-400/10 border-red-500/20';

  const materialBreakdown = useMemo(() => {
    const breakdown = new Map<string, { count: number; totalArea: number; wasteArea: number }>();

    for (const layout of result.layouts) {
      const ref = parseStockInstanceId(layout.stockInstanceId);
      if (!ref) continue;
      const stockItem = stock.find((s) => s.id === ref.stockId);
      if (!stockItem) continue;

      let entry = breakdown.get(stockItem.materialId);
      if (!entry) {
        entry = { count: 0, totalArea: 0, wasteArea: 0 };
        breakdown.set(stockItem.materialId, entry);
      }

      entry.count += 1;
      const area = stockItem.width * stockItem.height;
      entry.totalArea += area;
      entry.wasteArea += area * layout.wastePct;
    }

    return Array.from(breakdown.entries()).map(([materialId, data]) => {
      const material = materials.find((m) => m.id === materialId);
      const wastePct = data.totalArea > 0 ? (data.wasteArea / data.totalArea) * 100 : 0;
      return {
        materialName: material?.name || 'Unknown',
        count: data.count,
        wastePct: wastePct.toFixed(1),
      };
    });
  }, [result.layouts, stock, materials]);

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 sm:p-6 flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-slate-100">Layout Summary</h2>
          <p className="text-sm text-slate-400 mt-1">
            {result.layouts.length} sheet{result.layouts.length !== 1 ? 's' : ''} used
          </p>
        </div>
        <div className={`px-4 py-2 rounded-lg border flex items-center gap-3 ${wasteColor}`}>
          <span className="text-xs uppercase tracking-wider font-semibold opacity-80">
            Total Waste
          </span>
          <span className="text-xl font-bold">{wastePct}%</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-slate-950/50 rounded-lg p-4 border border-slate-800/50">
          <div className="text-xs text-slate-400 mb-1 uppercase tracking-wider font-medium">
            Parts Placed
          </div>
          <div className="text-2xl font-semibold text-slate-100">
            {placedParts} <span className="text-sm text-slate-500 font-normal">/ {totalParts}</span>
          </div>
        </div>
        <div className="bg-slate-950/50 rounded-lg p-4 border border-slate-800/50">
          <div className="text-xs text-slate-400 mb-1 uppercase tracking-wider font-medium">
            Unplaced
          </div>
          <div className="text-2xl font-semibold text-slate-100 flex items-baseline gap-2">
            <span className={unplacedPartsCount > 0 ? 'text-amber-400' : 'text-slate-100'}>
              {unplacedPartsCount}
            </span>
          </div>
        </div>
      </div>

      {materialBreakdown.length > 0 && (
        <div className="mt-2">
          <h3 className="text-sm font-medium text-slate-300 mb-3">Material Breakdown</h3>
          <div className="space-y-2">
            {materialBreakdown.map((b) => (
              <div
                key={b.materialName}
                className="flex items-center justify-between text-sm py-2 border-b border-slate-800/50 last:border-0"
              >
                <span className="text-slate-300">{b.materialName}</span>
                <div className="flex items-center gap-4">
                  <span className="text-slate-400">
                    {b.count} sheet{b.count !== 1 ? 's' : ''}
                  </span>
                  <span className="font-mono text-emerald-400 w-12 text-right">{b.wastePct}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
