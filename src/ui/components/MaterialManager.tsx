import { useState } from 'react';
import type { Material } from '../../domain/types';
import { formatLength, parseLength, type Unit } from '../../domain/units';
import type { DisplayUnit } from '../state/types';

interface MaterialManagerProps {
  materials: Material[];
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  selectedMaterialId: string | 'all';
  onSelectMaterialFilter: (id: string | 'all') => void;
  onAddMaterial: (material: Omit<Material, 'id'>) => void;
  onUpdateMaterial: (id: string, material: Partial<Material>) => void;
  onDeleteMaterial: (id: string) => void;
}

// Preset wood color palettes for visual material badges
const MATERIAL_COLORS = [
  'bg-amber-500/20 text-amber-300 border-amber-500/40',
  'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  'bg-sky-500/20 text-sky-300 border-sky-500/40',
  'bg-purple-500/20 text-purple-300 border-purple-500/40',
  'bg-rose-500/20 text-rose-300 border-rose-500/40',
  'bg-orange-500/20 text-orange-300 border-orange-500/40',
];

export function MaterialManager({
  materials,
  displayUnit,
  fractionDenominator,
  selectedMaterialId,
  onSelectMaterialFilter,
  onAddMaterial,
  onUpdateMaterial,
  onDeleteMaterial,
}: MaterialManagerProps) {
  const defaultUnit: Unit = displayUnit.startsWith('imperial') ? 'in' : 'mm';

  const [isAdding, setIsAdding] = useState(false);
  const [newMaterialName, setNewMaterialName] = useState('');
  const [newMaterialThickness, setNewMaterialThickness] = useState('3/4"');
  const [newMaterialHasGrain, setNewMaterialHasGrain] = useState(true);
  const [thicknessError, setThicknessError] = useState<string | null>(null);

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseLength(newMaterialThickness, defaultUnit);
    if (!parsed.ok) {
      setThicknessError(parsed.error.message);
      return;
    }

    if (!newMaterialName.trim()) {
      setThicknessError('Material name is required.');
      return;
    }

    onAddMaterial({
      name: newMaterialName.trim(),
      thickness: parsed.mm,
      hasGrain: newMaterialHasGrain,
    });

    setNewMaterialName('');
    setNewMaterialThickness(defaultUnit === 'in' ? '3/4"' : '18mm');
    setNewMaterialHasGrain(true);
    setThicknessError(null);
    setIsAdding(false);
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-sm shadow-md flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold tracking-wide uppercase text-slate-200 flex items-center gap-2">
            <span>🪵</span> Materials ({materials.length})
          </h3>
          <span className="text-xs text-slate-400 font-normal hidden sm:inline">
            — Filter views or add project materials
          </span>
        </div>

        <button
          type="button"
          onClick={() => setIsAdding(!isAdding)}
          className="px-3 py-1 bg-amber-500 hover:bg-amber-600 text-slate-950 font-medium text-xs rounded-lg transition shadow-sm"
        >
          {isAdding ? 'Cancel' : '+ Add Material'}
        </button>
      </div>

      {/* Material Filter Tabs & List */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => onSelectMaterialFilter('all')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
            selectedMaterialId === 'all'
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-sm'
              : 'bg-slate-950 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-200'
          }`}
        >
          All Materials
        </button>

        {materials.map((mat, idx) => {
          const colorStyle = MATERIAL_COLORS[idx % MATERIAL_COLORS.length];
          const formattedThickness = formatLength(mat.thickness, {
            unit: defaultUnit,
            denominator: fractionDenominator,
            markApproximate: false,
          });

          return (
            <div
              key={mat.id}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                selectedMaterialId === mat.id
                  ? colorStyle
                  : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectMaterialFilter(mat.id)}
                className="flex items-center gap-1.5 focus:outline-none"
              >
                <span>{mat.name}</span>
                <span className="text-[10px] opacity-75 font-mono">({formattedThickness})</span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdateMaterial(mat.id, { hasGrain: !mat.hasGrain });
                }}
                className="text-[11px] opacity-80 hover:opacity-100 transition"
                title={
                  mat.hasGrain
                    ? 'Wood Grain enabled (click to toggle off)'
                    : 'No Grain / Uniform (click to enable grain)'
                }
              >
                {mat.hasGrain ? '🪵' : '⚪'}
              </button>

              {materials.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteMaterial(mat.id);
                  }}
                  className="text-slate-500 hover:text-red-400 transition ml-1 text-sm font-bold"
                  title={`Delete ${mat.name}`}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Material Form */}
      {isAdding && (
        <form
          onSubmit={handleAddSubmit}
          className="mt-2 p-3 bg-slate-950 border border-slate-800 rounded-lg flex flex-wrap items-end gap-3"
        >
          <div className="flex-1 min-w-[140px]">
            <label
              htmlFor="material-name"
              className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1"
            >
              Material Name
            </label>
            <input
              id="material-name"
              type="text"
              required
              placeholder="e.g. 3/4 Oak Plywood"
              value={newMaterialName}
              onChange={(e) => setNewMaterialName(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-slate-100 text-xs rounded-md px-2.5 py-1.5 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="w-28">
            <label
              htmlFor="material-thickness"
              className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1"
            >
              Thickness
            </label>
            <input
              id="material-thickness"
              type="text"
              required
              placeholder='e.g. 3/4"'
              value={newMaterialThickness}
              onChange={(e) => setNewMaterialThickness(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-slate-100 text-xs rounded-md px-2.5 py-1.5 font-mono focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2 pb-1.5">
            <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={newMaterialHasGrain}
                onChange={(e) => setNewMaterialHasGrain(e.target.checked)}
                className="rounded border-slate-700 text-amber-500 focus:ring-amber-500 bg-slate-900"
              />
              Has Grain
            </label>
          </div>

          <button
            type="submit"
            className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-semibold text-xs rounded-md transition"
          >
            Save Material
          </button>

          {thicknessError && <p className="w-full text-xs text-red-400 mt-1">{thicknessError}</p>}
        </form>
      )}
    </div>
  );
}
