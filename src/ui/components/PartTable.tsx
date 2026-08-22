import type { DragEvent } from 'react';
import { useEffect, useState } from 'react';
import type { Material, Part } from '../../domain/types';
import { formatLength, parseLength, type Unit } from '../../domain/units';
import type { DisplayUnit } from '../state/types';

interface PartTableProps {
  parts: Part[];
  materials: Material[];
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  selectedMaterialId: string | 'all';
  hoveredPartId: string | null;
  onHoverPart: (id: string | null) => void;
  onAddPart: (part: Omit<Part, 'id'>) => void;
  onUpdatePart: (id: string, part: Partial<Part>) => void;
  onDeletePart: (id: string) => void;
  onDuplicatePart: (id: string) => void;
  onClearParts: () => void;
  onOpenImport: () => void;
  onImportFiles: (files: File[]) => void;
}

interface PartRowProps {
  part: Part;
  materials: Material[];
  defaultUnit: Unit;
  fractionDenominator: number;
  isHovered: boolean;
  onHoverPart: (id: string | null) => void;
  onUpdatePart: (id: string, part: Partial<Part>) => void;
  onDeletePart: (id: string) => void;
  onDuplicatePart: (id: string) => void;
}

function PartRow({
  part,
  materials,
  defaultUnit,
  fractionDenominator,
  isHovered,
  onHoverPart,
  onUpdatePart,
  onDeletePart,
  onDuplicatePart,
}: PartRowProps) {
  const [widthStr, setWidthStr] = useState('');
  const [heightStr, setHeightStr] = useState('');
  const [widthError, setWidthError] = useState<string | null>(null);
  const [heightError, setHeightError] = useState<string | null>(null);

  useEffect(() => {
    setWidthStr(
      formatLength(part.width, {
        unit: defaultUnit,
        denominator: fractionDenominator,
        markApproximate: false,
      }),
    );
    setWidthError(null);
  }, [part.width, defaultUnit, fractionDenominator]);

  useEffect(() => {
    setHeightStr(
      formatLength(part.height, {
        unit: defaultUnit,
        denominator: fractionDenominator,
        markApproximate: false,
      }),
    );
    setHeightError(null);
  }, [part.height, defaultUnit, fractionDenominator]);

  const handleWidthBlur = () => {
    const parsed = parseLength(widthStr, defaultUnit);
    if (parsed.ok) {
      setWidthError(null);
      onUpdatePart(part.id, { width: parsed.mm });
    } else {
      setWidthError(parsed.error.message);
    }
  };

  const handleHeightBlur = () => {
    const parsed = parseLength(heightStr, defaultUnit);
    if (parsed.ok) {
      setHeightError(null);
      onUpdatePart(part.id, { height: parsed.mm });
    } else {
      setHeightError(parsed.error.message);
    }
  };

  return (
    <tr
      onMouseEnter={() => onHoverPart(part.id)}
      onMouseLeave={() => onHoverPart(null)}
      className={`border-b border-slate-800/60 transition ${
        isHovered ? 'bg-amber-500/10' : 'hover:bg-slate-800/40'
      }`}
    >
      {/* Label */}
      <td className="px-3 py-2.5">
        <input
          type="text"
          value={part.label}
          onChange={(e) => onUpdatePart(part.id, { label: e.target.value })}
          className="w-full bg-slate-950/80 border border-slate-800 focus:border-amber-500 text-slate-100 text-xs rounded px-2 py-1 focus:outline-none"
        />
      </td>

      {/* Material */}
      <td className="px-3 py-2.5">
        <select
          value={part.materialId}
          onChange={(e) => onUpdatePart(part.id, { materialId: e.target.value })}
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
          value={part.qty}
          onChange={(e) =>
            onUpdatePart(part.id, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })
          }
          className="w-16 bg-slate-950/80 border border-slate-800 focus:border-amber-500 text-slate-100 text-xs font-mono rounded px-2 py-1 text-center focus:outline-none"
        />
      </td>

      {/* Grain Lock */}
      <td className="px-3 py-2.5 text-center">
        <button
          type="button"
          onClick={() =>
            onUpdatePart(part.id, {
              rotationPolicy: part.rotationPolicy === 'locked' ? 'free90' : 'locked',
            })
          }
          className={`px-2.5 py-1 rounded text-[11px] font-medium transition border ${
            part.rotationPolicy === 'locked'
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
              : 'bg-slate-950 text-slate-400 border-slate-800 hover:border-slate-700'
          }`}
          title={
            part.rotationPolicy === 'locked'
              ? 'Grain Locked: Solver will NOT rotate this part'
              : 'Free 90°: Solver MAY rotate this part 90 degrees'
          }
        >
          {part.rotationPolicy === 'locked' ? '🔒 Locked' : '🔄 Free 90°'}
        </button>
      </td>

      {/* Actions */}
      <td className="px-3 py-2.5 text-right whitespace-nowrap">
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => onDuplicatePart(part.id)}
            className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition"
            title="Duplicate part"
          >
            📋
          </button>
          <button
            type="button"
            onClick={() => onDeletePart(part.id)}
            className="p-1 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition"
            title="Delete part"
          >
            🗑️
          </button>
        </div>
      </td>
    </tr>
  );
}

export function PartTable({
  parts,
  materials,
  displayUnit,
  fractionDenominator,
  selectedMaterialId,
  hoveredPartId,
  onHoverPart,
  onAddPart,
  onUpdatePart,
  onDeletePart,
  onDuplicatePart,
  onClearParts,
  onOpenImport,
  onImportFiles,
}: PartTableProps) {
  const defaultUnit: Unit = displayUnit.startsWith('imperial') ? 'in' : 'mm';
  const [isDragOver, setIsDragOver] = useState(false);

  const filteredParts =
    selectedMaterialId === 'all' ? parts : parts.filter((p) => p.materialId === selectedMaterialId);

  const handleAddDefaultPart = () => {
    const targetMaterialId =
      selectedMaterialId !== 'all' ? selectedMaterialId : (materials[0]?.id ?? 'default');

    onAddPart({
      label: `Part ${parts.length + 1}`,
      width: defaultUnit === 'in' ? 609.6 : 600, // 24" or 600mm
      height: defaultUnit === 'in' ? 304.8 : 300, // 12" or 300mm
      qty: 1,
      materialId: targetMaterialId,
      rotationPolicy: 'free90',
    });
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-sm shadow-md flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold tracking-wide uppercase text-slate-200 flex items-center gap-2">
            <span>✂️</span> Cut List Parts ({filteredParts.length})
          </h3>
        </div>

        <div className="flex items-center gap-2">
          {parts.length > 0 && (
            <button
              type="button"
              onClick={onClearParts}
              className="px-2.5 py-1 text-xs text-slate-400 hover:text-red-400 transition hover:bg-slate-800 rounded"
            >
              Clear All
            </button>
          )}

          <button
            type="button"
            onClick={onOpenImport}
            className="px-2.5 py-1 text-xs text-slate-300 hover:text-amber-300 transition hover:bg-slate-800 rounded border border-slate-800"
          >
            Import
          </button>

          <button
            type="button"
            onClick={handleAddDefaultPart}
            className="px-3 py-1 bg-amber-500 hover:bg-amber-600 text-slate-950 font-semibold text-xs rounded-lg transition shadow-sm"
          >
            + Add Part
          </button>
        </div>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop file target, no semantic interactive role applies to a native HTML5 drop zone */}
      <div
        onDragOver={(e: DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e: DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          setIsDragOver(false);
          if (e.dataTransfer.files.length > 0) onImportFiles(Array.from(e.dataTransfer.files));
        }}
        className={`overflow-x-auto rounded-lg transition-colors ${
          isDragOver ? 'ring-2 ring-amber-500/60 bg-amber-500/5' : ''
        }`}
      >
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <th className="px-3 py-2">Part Label</th>
              <th className="px-3 py-2">Material</th>
              <th className="px-3 py-2 w-32">Width</th>
              <th className="px-3 py-2 w-32">Height</th>
              <th className="px-3 py-2 w-20 text-center">Qty</th>
              <th className="px-3 py-2 text-center">Grain Lock</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredParts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-slate-500 text-xs italic">
                  No parts added yet. Click "+ Add Part" above to get started.
                </td>
              </tr>
            ) : (
              filteredParts.map((part) => (
                <PartRow
                  key={part.id}
                  part={part}
                  materials={materials}
                  defaultUnit={defaultUnit}
                  fractionDenominator={fractionDenominator}
                  isHovered={hoveredPartId === part.id}
                  onHoverPart={onHoverPart}
                  onUpdatePart={onUpdatePart}
                  onDeletePart={onDeletePart}
                  onDuplicatePart={onDuplicatePart}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
