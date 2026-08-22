import type { CutPlan } from '../../domain/cutplan';
import type { Material, Part, Result, SolverConfig, Stock } from '../../domain/types';
import type { DisplayUnit } from '../../domain/units';

export type { DisplayUnit } from '../../domain/units';

export interface AppState {
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  materials: Material[];
  parts: Part[];
  stock: Stock[];
  config: SolverConfig;
  activeSheetIndex: number;
  hoveredPartId: string | null;
  selectedMaterialId: string | 'all';
  /**
   * Whether the derived cut sequence is shown: blade lines and step numbers on
   * the diagram, piece letters on the parts, and the step list beside it.
   *
   * It lives in app state rather than inside the viewer because the printed
   * pages and the exported SVG/DXF read it too. One switch for all four is what
   * keeps the promise that the file a user exports matches the diagram they
   * were looking at when they asked for it.
   */
  showCutSequence: boolean;
}

export type CutListAction =
  | { type: 'SET_UNIT'; unit: DisplayUnit }
  | { type: 'SET_FRACTION_DENOMINATOR'; denominator: number }
  | { type: 'SET_CONFIG'; config: Partial<SolverConfig> }
  | { type: 'SET_ACTIVE_SHEET'; index: number }
  | { type: 'SET_HOVERED_PART'; partId: string | null }
  | { type: 'SET_MATERIAL_FILTER'; materialId: string | 'all' }
  | { type: 'SET_CUT_SEQUENCE'; show: boolean }
  | { type: 'ADD_MATERIAL'; material: Material }
  | { type: 'UPDATE_MATERIAL'; id: string; material: Partial<Material> }
  | { type: 'DELETE_MATERIAL'; id: string }
  | { type: 'ADD_PART'; part: Part }
  | { type: 'UPDATE_PART'; id: string; part: Partial<Part> }
  | { type: 'DELETE_PART'; id: string }
  | { type: 'DUPLICATE_PART'; id: string }
  | { type: 'CLEAR_PARTS' }
  | { type: 'ADD_STOCK'; stock: Stock }
  | { type: 'UPDATE_STOCK'; id: string; stock: Partial<Stock> }
  | { type: 'DELETE_STOCK'; id: string }
  | { type: 'IMPORT_PARTS'; parts: Part[]; mode: 'append' | 'replace' }
  | {
      type: 'LOAD_PRESET';
      preset: {
        materials: Material[];
        parts: Part[];
        stock: Stock[];
        config?: Partial<SolverConfig>;
      };
    }
  | { type: 'RESET_ALL' };

export interface CutListStateReturn extends AppState {
  result: Result | null;
  solverError: string | null;
  /**
   * One plan per layout in `result`, in the same order. Empty when there is no
   * result, or when the plans could not be built.
   */
  cutPlans: CutPlan[];
  cutPlanError: string | null;
  dispatch: React.Dispatch<CutListAction>;
  // Action helpers
  setUnit: (unit: DisplayUnit) => void;
  setConfig: (config: Partial<SolverConfig>) => void;
  setActiveSheetIndex: (index: number) => void;
  setHoveredPartId: (id: string | null) => void;
  setSelectedMaterialId: (materialId: string | 'all') => void;
  setShowCutSequence: (show: boolean) => void;
  addMaterial: (material: Omit<Material, 'id'>) => string;
  updateMaterial: (id: string, material: Partial<Material>) => void;
  deleteMaterial: (id: string) => void;
  addPart: (part: Omit<Part, 'id'>) => string;
  updatePart: (id: string, part: Partial<Part>) => void;
  deletePart: (id: string) => void;
  duplicatePart: (id: string) => void;
  clearParts: () => void;
  addStock: (stock: Omit<Stock, 'id'>) => string;
  updateStock: (id: string, stock: Partial<Stock>) => void;
  deleteStock: (id: string) => void;
  importParts: (parts: Omit<Part, 'id'>[], mode: 'append' | 'replace') => void;
  loadPreset: (presetKey: string) => void;
  resetAll: () => void;
  reSolve: () => void;
}
