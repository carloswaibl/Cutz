import { useEffect, useState } from 'react';
import type { RotationSteps, SolverConfig, SolverMode } from '../../domain/types';
import { formatLength, parseLength, type Unit } from '../../domain/units';
import { DEFAULT_ROTATION_STEPS, solverMode } from '../../domain/validate';
import { createRng } from '../../solver/rng';
import type { DisplayUnit } from '../state/types';

/**
 * How many orientations the nester may try, and what each is worth saying.
 *
 * Written as what the woodworker gets rather than as a bare count: "12" means
 * nothing on its own, "every 30°" is the thing they are choosing. Cost rises
 * with the count - each orientation is a separate rasterisation of every part
 * and a separate scan of the sheet - so the two expensive ones say so.
 */
const ROTATION_OPTIONS: { value: RotationSteps; label: string }[] = [
  { value: 2, label: '2 - half turns only' },
  { value: 4, label: '4 - quarter turns' },
  { value: 12, label: '12 - every 30° (slower)' },
  { value: 24, label: '24 - every 15° (slowest)' },
];

interface ConfigBarProps {
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  onConfigChange: (config: Partial<SolverConfig>) => void;
  onReSolve?: () => void;
}

export function ConfigBar({
  config,
  displayUnit,
  fractionDenominator,
  onConfigChange,
  onReSolve,
}: ConfigBarProps) {
  const defaultUnit: Unit = displayUnit.startsWith('imperial') ? 'in' : 'mm';
  const mode = solverMode(config);

  // Same `config.kerf` either way - what changes is the tool making the cut. A
  // router has no saw blade, and a field naming one is a field describing a
  // machine the user has just said they are not using.
  const kerfLabel = mode === 'nest' ? 'Cutter Diameter' : 'Saw Blade Kerf';
  const kerfPlaceholder = mode === 'nest' ? 'e.g. 1/4"' : 'e.g. 1/8"';

  const [kerfInput, setKerfInput] = useState('');
  const [kerfError, setKerfError] = useState<string | null>(null);

  const [trimInput, setTrimInput] = useState('');
  const [trimError, setTrimError] = useState<string | null>(null);

  // Sync inputs with config when unit or config changes externally
  useEffect(() => {
    setKerfInput(
      formatLength(config.kerf, {
        unit: defaultUnit,
        denominator: fractionDenominator,
        markApproximate: false,
      }),
    );
    setKerfError(null);
  }, [config.kerf, defaultUnit, fractionDenominator]);

  useEffect(() => {
    setTrimInput(
      formatLength(config.edgeTrim, {
        unit: defaultUnit,
        denominator: fractionDenominator,
        markApproximate: false,
      }),
    );
    setTrimError(null);
  }, [config.edgeTrim, defaultUnit, fractionDenominator]);

  const handleKerfBlur = () => {
    const parsed = parseLength(kerfInput, defaultUnit);
    if (parsed.ok) {
      setKerfError(null);
      onConfigChange({ kerf: parsed.mm });
    } else {
      setKerfError(parsed.error.message);
    }
  };

  const handleTrimBlur = () => {
    const parsed = parseLength(trimInput, defaultUnit);
    if (parsed.ok) {
      setTrimError(null);
      onConfigChange({ edgeTrim: parsed.mm });
    } else {
      setTrimError(parsed.error.message);
    }
  };

  const handleReRollSeed = () => {
    const rng = createRng(config.seed + 1);
    const newSeed = rng.int(1000000) + 1;
    onConfigChange({ seed: newSeed });
    if (onReSolve) onReSolve();
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-sm shadow-md flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-6">
        {/* Machine.
            First, and in this bar rather than beside Effort in the header,
            because it is not a solver knob - it decides what kerf and edge trim
            mean and what the diagram below is a picture of. */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="machine-select"
            className="text-xs font-semibold uppercase tracking-wider text-slate-400"
          >
            Machine
          </label>
          <select
            id="machine-select"
            value={mode}
            onChange={(e) => onConfigChange({ mode: e.target.value as SolverMode })}
            className="bg-slate-950 text-slate-100 text-sm rounded-lg px-3 py-1.5 border border-slate-700 focus:outline-none focus:ring-1 focus:border-amber-500 focus:ring-amber-500 cursor-pointer"
          >
            <option value="guillotine">Table saw</option>
            <option value="nest">CNC router</option>
          </select>
        </div>

        {/* Rotations. Nesting only - a saw has only ever had two orientations,
            and `allowedAngles` ignores this field in guillotine mode. */}
        {mode === 'nest' && (
          <div className="flex items-center gap-2">
            <label
              htmlFor="rotations-select"
              className="text-xs font-semibold uppercase tracking-wider text-slate-400"
            >
              Rotations
            </label>
            <select
              id="rotations-select"
              value={config.rotationSteps ?? DEFAULT_ROTATION_STEPS}
              onChange={(e) =>
                onConfigChange({ rotationSteps: Number(e.target.value) as RotationSteps })
              }
              title="How many orientations the nester tries for each part. More angles pack tighter and take longer. Grain-locked parts stay at 0° or 180° whatever this says."
              className="bg-slate-950 text-slate-100 text-sm rounded-lg px-3 py-1.5 border border-slate-700 focus:outline-none focus:ring-1 focus:border-amber-500 focus:ring-amber-500 cursor-pointer"
            >
              {ROTATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-center gap-2">
          <label
            htmlFor="kerf-input"
            className="text-xs font-semibold uppercase tracking-wider text-slate-400"
          >
            {kerfLabel}
          </label>
          <div className="relative">
            <input
              id="kerf-input"
              type="text"
              value={kerfInput}
              onChange={(e) => setKerfInput(e.target.value)}
              onBlur={handleKerfBlur}
              className={`w-28 bg-slate-950 border ${
                kerfError
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-slate-700 focus:border-amber-500 focus:ring-amber-500'
              } text-slate-100 text-sm rounded-lg px-3 py-1.5 font-mono focus:outline-none focus:ring-1`}
              placeholder={kerfPlaceholder}
            />
            {kerfError && (
              <span className="absolute left-0 top-full mt-1 text-[11px] text-red-400 whitespace-nowrap bg-slate-900 border border-red-900/50 px-2 py-0.5 rounded shadow-lg z-10">
                {kerfError}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor="trim-input"
            className="text-xs font-semibold uppercase tracking-wider text-slate-400"
          >
            Edge Trim
          </label>
          <div className="relative">
            <input
              id="trim-input"
              type="text"
              value={trimInput}
              onChange={(e) => setTrimInput(e.target.value)}
              onBlur={handleTrimBlur}
              className={`w-28 bg-slate-950 border ${
                trimError
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-slate-700 focus:border-amber-500 focus:ring-amber-500'
              } text-slate-100 text-sm rounded-lg px-3 py-1.5 font-mono focus:outline-none focus:ring-1`}
              placeholder='e.g. 1/4"'
            />
            {trimError && (
              <span className="absolute left-0 top-full mt-1 text-[11px] text-red-400 whitespace-nowrap bg-slate-900 border border-red-900/50 px-2 py-0.5 rounded shadow-lg z-10">
                {trimError}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-500 font-mono">
          Seed: <span className="text-slate-300 font-semibold">{config.seed}</span>
        </span>
        <button
          type="button"
          onClick={handleReRollSeed}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-medium rounded-lg border border-slate-700 transition flex items-center gap-1.5 shadow-sm"
          title="Generate new PRNG seed for alternative layout combinations"
        >
          <span>🎲</span>
          <span>Re-roll Seed</span>
        </button>
      </div>
    </div>
  );
}
