import { useCallback, useMemo, useReducer } from 'react';
import type { Material, Part, Result, Stock } from '../../domain/types';
import { solve } from '../../solver/index';
import { BOOKSHELF_PRESET, PRESETS } from './presets';
import type { AppState, CutListAction, CutListStateReturn, DisplayUnit } from './types';

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
};

let nextId = 1;

function generateId(prefix: string): string {
  const idStr = (nextId++).toString(36);
  return `${prefix}-${Date.now().toString(36)}-${idStr}`;
}

function cutListReducer(state: AppState, action: CutListAction): AppState {
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
        parts: state.parts.map((p) => (p.id === action.id ? { ...p, ...action.part } : p)),
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

    case 'LOAD_PRESET':
      return {
        ...state,
        materials: action.preset.materials,
        parts: action.preset.parts,
        stock: action.preset.stock,
        config: action.preset.config ? { ...state.config, ...action.preset.config } : state.config,
        activeSheetIndex: 0,
        selectedMaterialId: 'all',
      };

    case 'RESET_ALL':
      return { ...INITIAL_STATE };

    default:
      return state;
  }
}

export function useCutListState(): CutListStateReturn {
  const [state, dispatch] = useReducer(cutListReducer, INITIAL_STATE);

  // Compute solver result live via useMemo
  const { result, solverError } = useMemo<{
    result: Result | null;
    solverError: string | null;
  }>(() => {
    if (state.parts.length === 0 || state.stock.length === 0) {
      return { result: null, solverError: null };
    }
    try {
      const res = solve(state.parts, state.stock, state.config);
      return { result: res, solverError: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: null, solverError: msg };
    }
  }, [state.parts, state.stock, state.config]);

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

  const loadPreset = useCallback((presetKey: string) => {
    const preset = PRESETS[presetKey];
    if (preset) {
      dispatch({ type: 'LOAD_PRESET', preset });
    }
  }, []);

  const resetAll = useCallback(() => {
    dispatch({ type: 'RESET_ALL' });
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
    dispatch,
    setUnit,
    setConfig,
    setActiveSheetIndex,
    setHoveredPartId,
    setSelectedMaterialId,
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
    loadPreset,
    resetAll,
    reSolve,
  };
}
