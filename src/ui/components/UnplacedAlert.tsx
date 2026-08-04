import { useMemo } from 'react';
import type { Part, SolverConfig, Stock, UnplacedPart } from '../../domain/types';
import { formatLength, type Unit } from '../../domain/units';
import type { DisplayUnit } from '../state/types';

interface UnplacedAlertProps {
  unplacedParts: UnplacedPart[];
  parts: Part[];
  stock: Stock[];
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
}

export function UnplacedAlert({
  unplacedParts,
  parts,
  stock,
  config,
  displayUnit,
  fractionDenominator,
}: UnplacedAlertProps) {
  const defaultUnit: Unit = displayUnit.startsWith('imperial') ? 'in' : 'mm';

  const alerts = useMemo(() => {
    if (unplacedParts.length === 0) return [];

    return unplacedParts.map((up) => {
      const part = parts.find((p) => p.id === up.partId);
      if (!part) return { label: 'Unknown Part', reason: 'Part not found in project.' };

      const partLabel = part.label;
      const partId = up.partId;
      const partDimensions = `${formatLength(part.width, { unit: defaultUnit, denominator: fractionDenominator })} × ${formatLength(part.height, { unit: defaultUnit, denominator: fractionDenominator })}`;

      const materialStock = stock.filter((s) => s.materialId === part.materialId && s.qty > 0);

      if (materialStock.length === 0) {
        return {
          id: partId,
          label: `${partLabel} (${partDimensions})`,
          reason: `No stock available for this material.`,
        };
      }

      // Check if part is too large for any stock
      let fitsAnyStock = false;
      let largestW = 0;
      let largestH = 0;

      for (const s of materialStock) {
        const usableW = s.width - config.edgeTrim * 2;
        const usableH = s.height - config.edgeTrim * 2;
        if (usableW > largestW) largestW = usableW;
        if (usableH > largestH) largestH = usableH;

        const fitsStandard = part.width <= usableW && part.height <= usableH;
        const fitsRotated =
          part.rotationPolicy === 'free90' && part.height <= usableW && part.width <= usableH;

        if (fitsStandard || fitsRotated) {
          fitsAnyStock = true;
          break;
        }
      }

      if (!fitsAnyStock) {
        return {
          id: partId,
          label: `${partLabel} (${partDimensions})`,
          reason: `Exceeds maximum usable sheet area (${formatLength(largestW, { unit: defaultUnit, denominator: fractionDenominator })} × ${formatLength(largestH, { unit: defaultUnit, denominator: fractionDenominator })} after edge trim).`,
        };
      }

      return {
        id: partId,
        label: `${partLabel} (${partDimensions})`,
        reason: `Insufficient stock sheets to fit remaining quantity (${up.qty}).`,
      };
    });
  }, [unplacedParts, parts, stock, config, defaultUnit, fractionDenominator]);

  if (alerts.length === 0) return null;

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 sm:p-5 flex gap-4 text-amber-500 items-start">
      <div className="mt-0.5 flex-shrink-0">
        <svg
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </div>
      <div>
        <h3 className="text-base font-semibold text-amber-400 mb-1">
          {unplacedParts.length} Part{unplacedParts.length !== 1 ? 's' : ''} Could Not Be Placed
        </h3>
        <ul className="list-disc list-inside space-y-1 text-sm text-amber-200/90">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <span className="font-medium text-amber-300">{alert.label}</span>: {alert.reason}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
