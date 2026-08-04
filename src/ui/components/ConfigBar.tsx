import { useEffect, useState } from 'react';
import type { SolverConfig } from '../../domain/types';
import { formatLength, parseLength, type Unit } from '../../domain/units';
import { createRng } from '../../solver/rng';
import type { DisplayUnit } from '../state/types';

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
        <div className="flex items-center gap-2">
          <label
            htmlFor="kerf-input"
            className="text-xs font-semibold uppercase tracking-wider text-slate-400"
          >
            Saw Blade Kerf
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
              placeholder='e.g. 1/8"'
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
