/**
 * Length formatting at the UI boundary.
 *
 * The domain stores millimetres and nothing else; this is where a number
 * becomes something a person reads, in whichever unit system they picked. It
 * lives outside `components/` because the diagram, the cut list, and the
 * printed pages all need the same answer - a shelf that reads `30"` on screen
 * and `29-63/64"` on paper is a support request.
 */

import { formatLength, type Unit } from '../domain/units';
import type { DisplayUnit } from './state/types';

/** The `formatLength` unit behind a display-unit choice. */
export function toFormatUnit(displayUnit: DisplayUnit): Unit {
  return displayUnit.startsWith('imperial') ? 'in' : 'mm';
}

/** The suffix shown after a formatted length, matching the display unit. */
export function unitSuffix(displayUnit: DisplayUnit): string {
  return displayUnit.startsWith('imperial') ? '"' : ' mm';
}

/**
 * A millimetre value as display text, with its unit.
 *
 * `markApproximate` is off: the fractional inch shown is the one to set the
 * fence to, and a `~` in front of it invites the reader to wonder how far off
 * it is rather than to cut.
 */
export function formatDisplayLength(
  mm: number,
  displayUnit: DisplayUnit,
  denominator: number,
): string {
  const value = formatLength(mm, {
    unit: toFormatUnit(displayUnit),
    denominator,
    withUnit: false,
    markApproximate: false,
  });
  return `${value}${unitSuffix(displayUnit)}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * A timestamp as "2 hours ago" for the project switcher's last-modified
 * column. Falls back to a plain date past a week, where "N weeks ago" stops
 * being a useful estimate for a woodworker deciding which project to open.
 */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE_MS) return 'just now';
  if (delta < HOUR_MS) return pluralize(Math.floor(delta / MINUTE_MS), 'minute');
  if (delta < DAY_MS) return pluralize(Math.floor(delta / HOUR_MS), 'hour');
  if (delta < WEEK_MS) return pluralize(Math.floor(delta / DAY_MS), 'day');
  return new Date(ms).toLocaleDateString();
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
