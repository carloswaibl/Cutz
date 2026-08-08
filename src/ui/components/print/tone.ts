/**
 * Text colours for components that render both on screen and on paper.
 *
 * The cut list and the cut sequence appear twice in the app: once in the dark
 * interactive UI, once inside the printed document. Rather than two copies of
 * each component, they take a `variant` and read their classes from here.
 *
 * This is the same argument `sheetTheme.ts` makes for the diagram, in Tailwind
 * classes rather than SVG attributes: two renderings of one table eventually
 * disagree about what the table says.
 */

export type ToneVariant = 'screen' | 'print';

export interface Tone {
  /** Body text. */
  text: string;
  /** Secondary text: units, counts, qualifiers. */
  muted: string;
  /** Text that is present but deliberately recessive, e.g. offcuts. */
  faint: string;
  /** Section headings. */
  heading: string;
  /** Table rules and header underlines. */
  rule: string;
  /** The one value per row the operator is looking for. */
  accent: string;
}

export const TONES: Record<ToneVariant, Tone> = {
  screen: {
    text: 'text-slate-300',
    muted: 'text-slate-400',
    faint: 'text-slate-500',
    heading: 'text-slate-200',
    rule: 'border-slate-800',
    accent: 'text-amber-300',
  },
  print: {
    text: 'text-slate-900',
    muted: 'text-slate-700',
    faint: 'text-slate-500',
    heading: 'text-slate-900',
    rule: 'border-slate-400',
    accent: 'text-slate-900',
  },
};
