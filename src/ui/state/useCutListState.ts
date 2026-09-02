import { useCallback, useMemo, useReducer } from 'react';
import { buildCutPlans, type CutPlan } from '../../domain/cutplan';
import { fitPolygonToBox } from '../../domain/polygon';
import type { Material, Part, Stock } from '../../domain/types';
import { BOOKSHELF_PRESET } from './presets';
import type {
  AppState,
  CutListAction,
  CutListStateReturn,
  DisplayUnit,
  ProjectFields,
} from './types';
import { useSolve } from './useSolve';

const INITIAL_STATE: AppState = {
  displayUnit: 'imperial-fraction',
  fractionDenominator: 16,
  materials: BOOKSHELF_PRESET.materials,
  parts: BOOKSHELF_PRESET.parts,
  stock: BOOKSHELF_PRESET.stock,
  config: BOOKSHELF_PRESET.config,
  activeSheetIndex: 0,
  hoveredPartId: null,
  selectedMaterialId: 'all',
  showCutSequence: true,
  projectGeneration: 0,
};

let nextId = 1;

function generateId(prefix: string): string {
  const idStr = (nextId++).toString(36);
  return `${prefix}-${Date.now().toString(36)}-${idStr}`;
}

/**
 * Keep an edited part's outline on its bounding box.
 *
 * `Part.outline` is defined as spanning exactly `width` x `height`, and
 * `validateInputs` enforces that as an **error** - one stale outline blocks
 * solving for every material at once. A user retyping the width of a part they
 * imported from an SVG would otherwise do exactly that, and be told about a
 * polygon they have never seen and cannot edit.
 *
 * The shape stretches to the new size, which is what dragging a handle does in
 * any drawing program, rather than being silently dropped - a part quietly
 * turning back into a rectangle is the kind of change a woodworker discovers at
 * the router.
 */
function resized(part: Part): Part {
  if (part.outline === undefined) return part;
  return { ...part, outline: fitPolygonToBox(part.outline, part.width, part.height) };
}

export function cutListReducer(state: AppState, action: CutListAction): AppState {
  switch (action.type) {
    case 'SET_UNIT':
      return { ...state, displayUnit: action.unit };

    case 'SET_FRACTION_DENOMINATOR':
      return { ...state, fractionDenominator: action.denominator };

    case 'SET_CONFIG':
      return { ...state, config: { ...state.config, ...action.config } };

    case 'SET_ACTIVE_SHEET':
      return { ...state, activeSheetIndex: action.index };

    case 'SET_HOVERED_PART':
      return { ...state, hoveredPartId: action.partId };

    case 'SET_MATERIAL_FILTER':
      return { ...state, selectedMaterialId: action.materialId, activeSheetIndex: 0 };

    case 'SET_CUT_SEQUENCE':
      return { ...state, showCutSequence: action.show };

    case 'ADD_MATERIAL':
      return { ...state, materials: [...state.materials, action.material] };

    case 'UPDATE_MATERIAL':
      return {
        ...state,
        materials: state.materials.map((m) =>
          m.id === action.id ? { ...m, ...action.material } : m,
        ),
      };

    case 'DELETE_MATERIAL':
      return {
        ...state,
        materials: state.materials.filter((m) => m.id !== action.id),
        parts: state.parts.filter((p) => p.materialId !== action.id),
        stock: state.stock.filter((s) => s.materialId !== action.id),
      };

    case 'ADD_PART':
      return { ...state, parts: [...state.parts, action.part] };

    case 'UPDATE_PART':
      return {
        ...state,
        parts: state.parts.map((p) => (p.id === action.id ? resized({ ...p, ...action.part }) : p)),
      };

    case 'DELETE_PART':
      return {
        ...state,
        parts: state.parts.filter((p) => p.id !== action.id),
      };

    case 'DUPLICATE_PART': {
      const partToDup = state.parts.find((p) => p.id === action.id);
      if (!partToDup) return state;
      const duplicated: Part = {
        ...partToDup,
        id: generateId('part'),
        label: `${partToDup.label} (Copy)`,
      };
      const idx = state.parts.findIndex((p) => p.id === action.id);
      const newParts = [...state.parts];
      newParts.splice(idx + 1, 0, duplicated);
      return { ...state, parts: newParts };
    }

    case 'CLEAR_PARTS':
      return { ...state, parts: [] };

    case 'ADD_STOCK':
      return { ...state, stock: [...state.stock, action.stock] };

    case 'UPDATE_STOCK':
      return {
        ...state,
        stock: state.stock.map((s) => (s.id === action.id ? { ...s, ...action.stock } : s)),
      };

    case 'DELETE_STOCK':
      return {
        ...state,
        stock: state.stock.filter((s) => s.id !== action.id),
      };

    case 'IMPORT_PARTS':
      return {
        ...state,
        parts: action.mode === 'replace' ? action.parts : [...state.parts, ...action.parts],
        activeSheetIndex: 0,
      };

    case 'LOAD_PROJECT':
      return {
        ...state,
        ...action.project,
        activeSheetIndex: 0,
        hoveredPartId: null,
        selectedMaterialId: 'all',
        projectGeneration: state.projectGeneration + 1,
      };

    default:
      return state;
  }
}

export function useCutListState(): CutListStateReturn {
  const [state, dispatch] = useReducer(cutListReducer, INITIAL_STATE);

  /**
   * The solver result, computed off the render path.
   *
   * This was a `useMemo` calling `solve()` synchronously, which was invisible
   * at guillotine's ~20ms and became seconds of frozen tab once the nester
   * landed (`docs/plan-m7.md` §1 criterion 8). `useSolve` runs the same solve in
   * a worker, keeps the previous layout on screen while a new one is computed,
   * and reports `isSolving` so the diagram can say the layout is stale.
   */
  const { result, solverError, isSolving } = useSolve(
    state.parts,
    state.stock,
    state.config,
    state.projectGeneration,
  );

  /**
   * Cut plans for the current result, built eagerly.
   *
   * `docs/plan-m3.md` PR 1 measured this across all ten fixtures: 0.09-2.21ms
   * to plan every sheet against 2.4-22.8ms to solve, under 10% of solve time in
   * every case. That is well below the threshold where a lazy path and a
   * loading state would earn their complexity, and the plans only rebuild when
   * the result does.
   *
   * `buildCutPlans` throws when a layout names a part or a stock entry the
   * project does not contain. That is an internal inconsistency rather than
   * user input, so it is caught the same way `solve` is and reported, never
   * swallowed into an empty cut list the user would read as "no cuts needed".
   */
  const { cutPlans, cutPlanError } = useMemo<{
    cutPlans: CutPlan[];
    cutPlanError: string | null;
  }>(() => {
    if (!result) return { cutPlans: [], cutPlanError: null };
    try {
      return {
        cutPlans: buildCutPlans(result, {
          parts: state.parts,
          stock: state.stock,
          materials: state.materials,
          config: state.config,
        }),
        cutPlanError: null,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { cutPlans: [], cutPlanError: msg };
    }
  }, [result, state.parts, state.stock, state.materials, state.config]);

  // Action helpers
  const setUnit = useCallback((unit: DisplayUnit) => {
    dispatch({ type: 'SET_UNIT', unit });
  }, []);

  const setConfig = useCallback((config: Partial<AppState['config']>) => {
    dispatch({ type: 'SET_CONFIG', config });
  }, []);

  const setActiveSheetIndex = useCallback((index: number) => {
    dispatch({ type: 'SET_ACTIVE_SHEET', index });
  }, []);

  const setHoveredPartId = useCallback((partId: string | null) => {
    dispatch({ type: 'SET_HOVERED_PART', partId });
  }, []);

  const setSelectedMaterialId = useCallback((materialId: string | 'all') => {
    dispatch({ type: 'SET_MATERIAL_FILTER', materialId });
  }, []);

  const setShowCutSequence = useCallback((show: boolean) => {
    dispatch({ type: 'SET_CUT_SEQUENCE', show });
  }, []);

  const addMaterial = useCallback((mat: Omit<Material, 'id'>): string => {
    const id = generateId('mat');
    dispatch({ type: 'ADD_MATERIAL', material: { ...mat, id } });
    return id;
  }, []);

  const updateMaterial = useCallback((id: string, material: Partial<Material>) => {
    dispatch({ type: 'UPDATE_MATERIAL', id, material });
  }, []);

  const deleteMaterial = useCallback((id: string) => {
    dispatch({ type: 'DELETE_MATERIAL', id });
  }, []);

  const addPart = useCallback((p: Omit<Part, 'id'>): string => {
    const id = generateId('part');
    dispatch({ type: 'ADD_PART', part: { ...p, id } });
    return id;
  }, []);

  const updatePart = useCallback((id: string, part: Partial<Part>) => {
    dispatch({ type: 'UPDATE_PART', id, part });
  }, []);

  const deletePart = useCallback((id: string) => {
    dispatch({ type: 'DELETE_PART', id });
  }, []);

  const duplicatePart = useCallback((id: string) => {
    dispatch({ type: 'DUPLICATE_PART', id });
  }, []);

  const clearParts = useCallback(() => {
    dispatch({ type: 'CLEAR_PARTS' });
  }, []);

  const importParts = useCallback((newParts: Omit<Part, 'id'>[], mode: 'append' | 'replace') => {
    const withIds = newParts.map((p) => ({ ...p, id: generateId('part') }));
    dispatch({ type: 'IMPORT_PARTS', parts: withIds, mode });
  }, []);

  const addStock = useCallback((s: Omit<Stock, 'id'>): string => {
    const id = generateId('stock');
    dispatch({ type: 'ADD_STOCK', stock: { ...s, id } });
    return id;
  }, []);

  const updateStock = useCallback((id: string, stock: Partial<Stock>) => {
    dispatch({ type: 'UPDATE_STOCK', id, stock });
  }, []);

  const deleteStock = useCallback((id: string) => {
    dispatch({ type: 'DELETE_STOCK', id });
  }, []);

  const loadProject = useCallback((project: ProjectFields) => {
    dispatch({ type: 'LOAD_PROJECT', project });
  }, []);

  const reSolve = useCallback(() => {
    // Re-roll seed to force solver to explore alternative packing configurations
    dispatch({
      type: 'SET_CONFIG',
      config: { seed: (state.config.seed + 1) % 1000000 },
    });
  }, [state.config.seed]);

  return {
    ...state,
    result,
    solverError,
    isSolving,
    cutPlans,
    cutPlanError,
    dispatch,
    setUnit,
    setConfig,
    setActiveSheetIndex,
    setHoveredPartId,
    setSelectedMaterialId,
    setShowCutSequence,
    addMaterial,
    updateMaterial,
    deleteMaterial,
    addPart,
    updatePart,
    deletePart,
    duplicatePart,
    clearParts,
    addStock,
    updateStock,
    deleteStock,
    importParts,
    loadProject,
    reSolve,
  };
}
