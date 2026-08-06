/**
 * The derived cut sequence for one sheet, as an ordered list of operations.
 *
 * Shared by the on-screen panel and the printed page - one component, two
 * palettes, so the list a user reads on the monitor and the list they carry to
 * the saw can never disagree about what to cut next.
 *
 * This is *a valid* cut order, not an optimised one. It is not reordered to
 * minimise fence changes or blade-height changes; that is a separate problem
 * and explicitly v2 (`docs/plan-m3.md` §2). The heading says so, because an
 * operator who assumes otherwise will fight the list rather than follow it.
 */

import type { CutPlan, CutStep } from '../../../domain/cutplan';
import type { Part } from '../../../domain/types';
import { formatDisplayLength } from '../../format';
import type { DisplayUnit } from '../../state/types';
import { TONES, type Tone, type ToneVariant } from './tone';

export interface CutSequenceListProps {
  plan: CutPlan;
  parts: readonly Part[];
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  /** Dark app chrome, or ink on paper. */
  variant?: ToneVariant;
  /**
   * Off where the container already names the section - the on-screen panel's
   * own `<summary>` is the heading, and a second one directly under it reads as
   * a rendering bug.
   */
  showHeading?: boolean;
}

/**
 * A plan that is not `complete` carries no steps, deliberately: half a cut plan
 * is worse than none, because the operator finds out where it stops by running
 * out of sheet. The two failures get different messages because they are
 * different facts - one layout cannot be cut at all, the other simply was not
 * proved either way before the search budget ran out.
 */
const STATUS_MESSAGE: Record<Exclude<CutPlan['status'], 'complete'>, string> = {
  invalid: 'This layout cannot be cut on a table saw with edge-to-edge cuts.',
  unverified: 'Cut sequence unavailable for this sheet - the search did not finish.',
};

export function CutSequenceList({
  plan,
  parts,
  displayUnit,
  fractionDenominator,
  variant = 'screen',
  showHeading = true,
}: CutSequenceListProps) {
  const tone = TONES[variant];

  if (plan.status !== 'complete') {
    return (
      <div className={`${tone.text} text-sm`}>
        {showHeading && <Heading tone={tone} stepCount={0} />}
        <p className={`mt-2 ${tone.muted}`}>{STATUS_MESSAGE[plan.status]}</p>
      </div>
    );
  }

  const keeperIds = keeperPieceIds(plan);
  const partLabelByPiece = partLabelsByPiece(plan, parts);

  return (
    <div className={`${tone.text} text-sm`}>
      {showHeading && <Heading tone={tone} stepCount={plan.steps.length} />}
      <table className="w-full mt-3 text-left tabular-nums" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr
            className={`text-[10px] uppercase tracking-wider border-b ${tone.rule} ${tone.faint}`}
          >
            <th className="py-1 pr-2 font-semibold w-8">#</th>
            <th className="py-1 pr-3 font-semibold">Cut</th>
            <th className="py-1 pr-3 font-semibold w-12">From</th>
            <th className="py-1 pr-3 font-semibold text-right">Fence</th>
            <th className="py-1 font-semibold">Yields</th>
          </tr>
        </thead>
        <tbody>
          {plan.steps.map((step) => (
            <tr
              key={step.index}
              className={`border-b last:border-0 ${tone.rule} break-inside-avoid`}
            >
              <td className={`py-1 pr-2 align-top font-mono text-xs ${tone.faint}`}>
                {step.index}
              </td>
              <td className="py-1 pr-3 align-top">
                {/* Indented by nesting depth: the deeper cuts are the ones made
                    to a piece already set aside from an earlier split. */}
                <span
                  className="whitespace-nowrap"
                  style={{ paddingLeft: `${Math.min(step.depth, 6) * 8}px` }}
                >
                  <span className={`font-medium ${tone.text}`}>{operationLabel(step)}</span>{' '}
                  <span className={`text-xs ${tone.faint}`}>{roleLabel(step.role)}</span>
                </span>
              </td>
              <td className={`py-1 pr-3 align-top font-mono ${tone.muted}`}>{step.pieceId}</td>
              <td
                className={`py-1 pr-3 align-top text-right font-mono font-semibold whitespace-nowrap ${tone.accent}`}
              >
                {fenceLabel(step, displayUnit, fractionDenominator)}
              </td>
              <td className="py-1 align-top">
                <Yields
                  step={step}
                  tone={tone}
                  keeperIds={keeperIds}
                  partLabelByPiece={partLabelByPiece}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Heading({ tone, stepCount }: { tone: Tone; stepCount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h4 className={`text-sm font-semibold ${tone.heading}`}>Cut sequence</h4>
      <p className={`text-[11px] ${tone.faint}`}>
        {stepCount > 0 ? `${stepCount} cut${stepCount === 1 ? '' : 's'} · ` : ''}a valid cut order,
        not reordered for fewest fence changes
      </p>
    </div>
  );
}

/** The pieces produced by one cut, saying which side the operator keeps. */
function Yields({
  step,
  tone,
  keeperIds,
  partLabelByPiece,
}: {
  step: CutStep;
  tone: Tone;
  keeperIds: ReadonlySet<string>;
  partLabelByPiece: ReadonlyMap<string, string>;
}) {
  const sides = step.produces.filter((id): id is string => id !== null);

  // Both sides null is impossible - `buildCutPlan` throws on a cut that leaves
  // nothing behind - but a single side can be, when the offcut was thinner than
  // the kerf and the blade simply consumed it.
  if (sides.length === 0) return <span className={tone.faint}>-</span>;

  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {sides.map((id) => {
        const partLabel = partLabelByPiece.get(id);
        if (partLabel !== undefined) {
          return (
            <span key={id} className={tone.text}>
              <span className="font-mono font-semibold">{id}</span> {partLabel}
            </span>
          );
        }
        const kept = keeperIds.has(id);
        return (
          <span key={id} className={kept ? tone.muted : tone.faint}>
            <span className="font-mono">{id}</span> {kept ? 'to cut' : 'offcut'}
          </span>
        );
      })}
      {step.produces.includes(null) && (
        <span className={tone.faint}>waste narrower than the kerf</span>
      )}
    </span>
  );
}

/** `Rip` / `Crosscut`, or plain `Cut` when the material has no grain. */
function operationLabel(step: CutStep): string {
  if (step.grain === 'rip') return 'Rip';
  if (step.grain === 'crosscut') return 'Crosscut';
  return 'Cut';
}

function roleLabel(role: CutStep['role']): string {
  if (role === 'trim') return 'edge trim';
  if (role === 'finish') return 'to size';
  return 'split';
}

/**
 * The fence setting for a cut, or `trim flush` where there is not one.
 *
 * `fence` is negative when the blade overhangs the piece's near edge, which
 * happens on a near-side finishing cut whose waste is thinner than the kerf.
 * There is no fence setting for a blade running partly in air, and printing a
 * plausible-looking number for it would send the operator to a stop that does
 * not exist.
 */
function fenceLabel(step: CutStep, displayUnit: DisplayUnit, denominator: number): string {
  if (step.fence < 0) return 'trim flush';
  return formatDisplayLength(step.fence, displayUnit, denominator);
}

/**
 * Pieces that go on to be something, rather than being set aside as offcut.
 *
 * A piece is a keeper when a later cut consumes it, or when it is a finished
 * part. Deriving it beats storing it on the step: the plan already records
 * which pieces get cut again, and a second source for the same fact is a second
 * thing to keep in step.
 */
function keeperPieceIds(plan: CutPlan): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const step of plan.steps) ids.add(step.pieceId);
  for (const piece of plan.pieces) {
    if (piece.placement !== null) ids.add(piece.id);
  }
  return ids;
}

/** Piece id -> the part label it is, for pieces that are finished parts. */
function partLabelsByPiece(plan: CutPlan, parts: readonly Part[]): ReadonlyMap<string, string> {
  const labelByPartId = new Map(parts.map((part) => [part.id, part.label]));
  const byPiece = new Map<string, string>();
  for (const piece of plan.pieces) {
    if (piece.placement === null) continue;
    const label = labelByPartId.get(piece.placement.partId);
    if (label !== undefined) byPiece.set(piece.id, label);
  }
  return byPiece;
}
