import { useEffect, useState } from 'react';
import type { Material, Stock } from '../../domain/types';
import { formatLength, parseLength, type Unit } from '../../domain/units';
import type { DisplayUnit } from '../state/types';

interface StockTableProps {
  stock: Stock[];
  materials: Material[];
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  selectedMaterialId: string | 'all';
  onAddStock: (stock: Omit<Stock, 'id'>) => void;
  onUpdateStock: (id: string, stock: Partial<Stock>) => void;
  onDeleteStock: (id: string) => void;
}

interface StockRowProps {
  item: Stock;
  materials: Material[];
  defaultUnit: Unit;
  fractionDenominator: number;
  onUpdateStock: (id: string, stock: Partial<Stock>) => void;
  onDeleteStock: (id: string) => void;
}

function StockRow({
  item,
  materials,
  defaultUnit,
  fractionDenominator,
  onUpdateStock,
  onDeleteStock,
}: StockRowProps) {
  const [widthStr, setWidthStr] = useState('');
  const [heightStr, setHeightStr] = useState('');
  const [widthError, setWidthError] = useState<string | null>(null);
  const [heightError, setHeightError] = useState<string | null>(null);

  useEffect(() => {
    setWidthStr(
      formatLength(item.width, {
        unit: defaultUnit,
        denominator: fractionDenominator,
        markApproximate: false,
      }),
    );
    setWidthError(null);
  }, [item.width, defaultUnit, fractionDenominator]);

  useEffect(() => {
    setHeightStr(
      formatLength(item.height, {
        unit: defaultUnit,
        denominator: fractionDenominator,
        markApproximate: false,
      }),
    );
    setHeightError(null);
  }, [item.height, defaultUnit, fractionDenominator]);

  const handleWidthBlur = () => {
    const parsed = parseLength(widthStr, defaultUnit);
    if (parsed.ok) {
      setWidthError(null);
      onUpdateStock(item.id, { width: parsed.mm });
    } else {
      setWidthError(parsed.error.message);
    }
  };

  const handleHeightBlur = () => {
    const parsed = parseLength(heightStr, defaultUnit);
    if (parsed.ok) {
      setHeightError(null);
      onUpdateStock(item.id, { height: parsed.mm });
    } else {
      setHeightError(parsed.error.message);
    }
  };

  return (
    <tr className="border-b border-slate-800/60 hover:bg-slate-800/40 transition">
      {/* Material */}
      <td className="px-3 py-2.5">
        <select
          value={item.materialId}
          onChange={(e) => onUpdateStock(item.id, { materialId: e.target.value })}
          className="w-full bg-slate-950/80 border border-slate-800 focus:border-amber-500 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none"
        >
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </td>

      {/* Width */}
      <td className="px-3 py-2.5 relative">
        <input
          type="text"
          value={widthStr}
          onChange={(e) => setWidthStr(e.target.value)}
          onBlur={handleWidthBlur}
          className={`w-full bg-slate-950/80 border ${
            widthError
              ? 'border-red-500 text-red-300'
              : 'border-slate-800 focus:border-amber-500 text-slate-100'
          } text-xs font-mono rounded px-2 py-1 focus:outline-none`}
        />
        {widthError && (
          <span className="absolute left-3 top-full mt-0.5 text-[10px] text-red-400 bg-slate-950 border border-red-900/50 px-1.5 py-0.5 rounded shadow z-10">
            {widthError}
          </span>
        )}
      </td>

      {/* Height */}
      <td className="px-3 py-2.5 relative">
        <input
          type="text"
          value={heightStr}
          onChange={(e) => setHeightStr(e.target.value)}
          onBlur={handleHeightBlur}
          className={`w-full bg-slate-950/80 border ${
            heightError
              ? 'border-red-500 text-red-300'
              : 'border-slate-800 focus:border-amber-500 text-slate-100'
          } text-xs font-mono rounded px-2 py-1 focus:outline-none`}
        />
        {heightError && (
          <span className="absolute left-3 top-full mt-0.5 text-[10px] text-red-400 bg-slate-950 border border-red-900/50 px-1.5 py-0.5 rounded shadow z-10">
            {heightError}
          </span>
        )}
      </td>

      {/* Quantity */}
      <td className="px-3 py-2.5">
        <input
          type="number"
          min="1"
          max="999"
          value={item.qty}
          onChange={(e) =>
            onUpdateStock(item.id, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })
          }
          className="w-16 bg-slate-950/80 border border-slate-800 focus:border-amber-500 text-slate-100 text-xs font-mono rounded px-2 py-1 text-center focus:outline-none"
        />
      </td>

      {/* Grain Axis */}
      <td className="px-3 py-2.5 text-center">
        <button
          type="button"
          onClick={() => onUpdateStock(item.id, { grainAxis: item.grainAxis === 'x' ? 'y' : 'x' })}
          className="px-2.5 py-1 bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-300 text-[11px] rounded font-mono transition"
          title="Toggle Stock Grain Direction (X = Along Width, Y = Along Height)"
        >
          Grain: {item.grainAxis.toUpperCase()} Axis
        </button>
      </td>

      {/* Actions */}
      <td className="px-3 py-2.5 text-right whitespace-nowrap">
        <button
          type="button"
          onClick={() => onDeleteStock(item.id)}
          className="p-1 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition"
          title="Delete stock sheet"
        >
          🗑️
        </button>
      </td>
    </tr>
  );
}

export function StockTable({
  stock,
  materials,
  displayUnit,
  fractionDenominator,
  selectedMaterialId,
  onAddStock,
  onUpdateStock,
  onDeleteStock,
}: StockTableProps) {
  const defaultUnit: Unit = displayUnit.startsWith('imperial') ? 'in' : 'mm';

  const filteredStock =
    selectedMaterialId === 'all' ? stock : stock.filter((s) => s.materialId === selectedMaterialId);

  const handleAddPreset = (widthMm: number, heightMm: number) => {
    const targetMaterialId =
      selectedMaterialId !== 'all' ? selectedMaterialId : (materials[0]?.id ?? 'default');

    onAddStock({
      materialId: targetMaterialId,
      width: widthMm,
      height: heightMm,
      qty: 1,
      grainAxis: 'y',
    });
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-sm shadow-md flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold tracking-wide uppercase text-slate-200 flex items-center gap-2">
            <span>📦</span> Available Stock Sheets ({filteredStock.length})
          </h3>
        </div>

        <button
          type="button"
          onClick={() =>
            handleAddPreset(
              defaultUnit === 'in' ? 1219.2 : 1220, // 48" or 1220mm
              defaultUnit === 'in' ? 2438.4 : 2440, // 96" or 2440mm
            )
          }
          className="px-3 py-1 bg-amber-500 hover:bg-amber-600 text-slate-950 font-semibold text-xs rounded-lg transition shadow-sm"
        >
          + Add Custom Stock
        </button>
      </div>

      {/* Stock Presets Quick-Add Bar */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/80 pt-2">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          Quick-Add Presets:
        </span>
        <button
          type="button"
          onClick={() => handleAddPreset(1219.2, 2438.4)}
          className="px-2 py-1 bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded text-xs font-mono transition"
        >
          + 4' x 8' (48" × 96")
        </button>
        <button
          type="button"
          onClick={() => handleAddPreset(1524, 1524)}
          className="px-2 py-1 bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded text-xs font-mono transition"
        >
          + 5' x 5' Baltic Birch (60" × 60")
        </button>
        <button
          type="button"
          onClick={() => handleAddPreset(609.6, 1219.2)}
          className="px-2 py-1 bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded text-xs font-mono transition"
        >
          + 2' x 4' Handy Panel (24" × 48")
        </button>
        <button
          type="button"
          onClick={() => handleAddPreset(1220, 2440)}
          className="px-2 py-1 bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded text-xs font-mono transition"
        >
          + 1220 × 2440 mm
        </button>
      </div>

      <div className="overflow-x-auto">
        {/* Same reasoning as `PartTable`: scroll before crushing a dimension. */}
        <table className="w-full min-w-[34rem] text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <th className="px-3 py-2">Material</th>
              <th className="px-3 py-2 w-28 min-w-[5.5rem]">Width</th>
              <th className="px-3 py-2 w-28 min-w-[5.5rem]">Height</th>
              <th className="px-3 py-2 w-20 text-center">Qty</th>
              <th className="px-3 py-2 text-center">Grain Direction</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredStock.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-slate-500 text-xs italic">
                  No stock sheets available for selected material. Click a Quick-Add preset above.
                </td>
              </tr>
            ) : (
              filteredStock.map((item) => (
                <StockRow
                  key={item.id}
                  item={item}
                  materials={materials}
                  defaultUnit={defaultUnit}
                  fractionDenominator={fractionDenominator}
                  onUpdateStock={onUpdateStock}
                  onDeleteStock={onDeleteStock}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
