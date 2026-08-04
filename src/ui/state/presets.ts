import type { Material, Part, SolverConfig, Stock } from '../../domain/types';
import { inchToMm } from '../../domain/units';

export interface PresetProject {
  id: string;
  name: string;
  description: string;
  materials: Material[];
  parts: Part[];
  stock: Stock[];
  config: SolverConfig;
}

/**
 * 3-Unit Bookshelf Preset
 * 3 matching bookshelf units: 6 sides, 24 shelves on 3/4" Plywood.
 */
export const BOOKSHELF_PRESET: PresetProject = {
  id: 'bookshelf',
  name: '3-Unit Bookshelf',
  description:
    'Three 5ft tall bookshelves with 4 shelves each (6 sides, 24 shelves). Fits on 3 sheets of 3/4" Plywood.',
  materials: [
    {
      id: 'mat-ply-34',
      name: '3/4" Hardwood Plywood',
      thickness: inchToMm(0.75), // 19.05mm
      hasGrain: true,
    },
  ],
  parts: [
    {
      id: 'p-side',
      label: 'Bookshelf Side',
      width: inchToMm(11.75), // 298.45mm
      height: inchToMm(60.0), // 1524.0mm
      qty: 6,
      materialId: 'mat-ply-34',
      rotationPolicy: 'locked',
    },
    {
      id: 'p-shelf',
      label: 'Shelf Panel',
      width: inchToMm(11.75), // 298.45mm
      height: inchToMm(30.0), // 762.0mm
      qty: 24,
      materialId: 'mat-ply-34',
      rotationPolicy: 'free90',
    },
  ],
  stock: [
    {
      id: 'st-ply-48x96',
      materialId: 'mat-ply-34',
      width: inchToMm(48.0), // 1219.2mm
      height: inchToMm(96.0), // 2438.4mm
      qty: 3,
      grainAxis: 'y',
    },
  ],
  config: {
    kerf: inchToMm(0.125), // 1/8" saw blade kerf (3.175mm)
    edgeTrim: inchToMm(0.25), // 1/4" factory edge trim (6.35mm)
    seed: 42,
    effort: 'balanced',
  },
};

/**
 * Wall Cabinet Carcasses Preset
 */
export const CABINET_CARCASS_PRESET: PresetProject = {
  id: 'cabinet-carcass',
  name: '8 Wall Cabinet Carcasses',
  description: 'Upper wall cabinets with tops, bottoms, sides, and fixed shelves.',
  materials: [
    {
      id: 'mat-ply-34',
      name: '3/4" Maple Plywood',
      thickness: inchToMm(0.75),
      hasGrain: true,
    },
  ],
  parts: [
    {
      id: 'p-cab-side',
      label: 'Cabinet Side',
      width: inchToMm(12.0),
      height: inchToMm(30.0),
      qty: 16,
      materialId: 'mat-ply-34',
      rotationPolicy: 'locked',
    },
    {
      id: 'p-cab-top-bottom',
      label: 'Top / Bottom',
      width: inchToMm(12.0),
      height: inchToMm(22.5),
      qty: 16,
      materialId: 'mat-ply-34',
      rotationPolicy: 'free90',
    },
    {
      id: 'p-cab-shelf',
      label: 'Adjustable Shelf',
      width: inchToMm(11.25),
      height: inchToMm(22.375),
      qty: 16,
      materialId: 'mat-ply-34',
      rotationPolicy: 'free90',
    },
  ],
  stock: [
    {
      id: 'st-ply-48x96',
      materialId: 'mat-ply-34',
      width: inchToMm(48.0),
      height: inchToMm(96.0),
      qty: 5,
      grainAxis: 'y',
    },
  ],
  config: {
    kerf: inchToMm(0.125),
    edgeTrim: inchToMm(0.25),
    seed: 12345,
    effort: 'balanced',
  },
};

/**
 * Drawer Boxes Preset (Multi-Material)
 */
export const DRAWER_BOXES_PRESET: PresetProject = {
  id: 'drawer-boxes',
  name: '12 Drawer Boxes (Multi-Material)',
  description: '12 drawer boxes requiring 12mm Baltic Birch sides and 6mm Plywood bottoms.',
  materials: [
    {
      id: 'mat-bb-12mm',
      name: '12mm Baltic Birch',
      thickness: 12.0,
      hasGrain: true,
    },
    {
      id: 'mat-ply-6mm',
      name: '6mm Birch Ply (Bottoms)',
      thickness: 6.0,
      hasGrain: false,
    },
  ],
  parts: [
    {
      id: 'p-drw-side',
      label: 'Drawer Side',
      width: 150.0,
      height: 500.0,
      qty: 24,
      materialId: 'mat-bb-12mm',
      rotationPolicy: 'locked',
    },
    {
      id: 'p-drw-front-back',
      label: 'Drawer Front/Back',
      width: 150.0,
      height: 400.0,
      qty: 24,
      materialId: 'mat-bb-12mm',
      rotationPolicy: 'free90',
    },
    {
      id: 'p-drw-bottom',
      label: 'Drawer Bottom',
      width: 390.0,
      height: 490.0,
      qty: 12,
      materialId: 'mat-ply-6mm',
      rotationPolicy: 'free90',
    },
  ],
  stock: [
    {
      id: 'st-bb-5x5',
      materialId: 'mat-bb-12mm',
      width: 1525.0, // 5' x 5' Baltic Birch
      height: 1525.0,
      qty: 3,
      grainAxis: 'y',
    },
    {
      id: 'st-ply-4x8',
      materialId: 'mat-ply-6mm',
      width: 1220.0,
      height: 2440.0,
      qty: 1,
      grainAxis: 'y',
    },
  ],
  config: {
    kerf: 3.175,
    edgeTrim: 6.35,
    seed: 999,
    effort: 'balanced',
  },
};

export const PRESETS: Record<string, PresetProject> = {
  bookshelf: BOOKSHELF_PRESET,
  'cabinet-carcass': CABINET_CARCASS_PRESET,
  'drawer-boxes': DRAWER_BOXES_PRESET,
};
