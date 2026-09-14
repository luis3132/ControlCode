import { create } from "zustand";

import type { SearchOptions, SearchResult } from "./ipc";

/**
 * El estado del buscador vive fuera del componente: pasar al árbol de archivos y volver
 * no puede borrar la búsqueda ni sus resultados — es justo lo que se hace para abrir un
 * resultado y seguir con el siguiente.
 */
interface SearchState {
  query: string;
  options: SearchOptions;
  /** Los globs de incluir/excluir se muestran recién cuando se piden. */
  showFilters: boolean;
  result: SearchResult | null;
  /** Para qué carpeta es `result`: al cambiar de workspace no sirve. */
  resultRoot: string | null;
  collapsed: Set<string>;
  setQuery: (query: string) => void;
  setOption: <K extends keyof SearchOptions>(key: K, value: SearchOptions[K]) => void;
  toggleFilters: () => void;
  setResult: (root: string, result: SearchResult | null) => void;
  toggleFile: (path: string) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: "",
  options: { isRegex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "" },
  showFilters: false,
  result: null,
  resultRoot: null,
  collapsed: new Set(),
  setQuery: (query) => set({ query }),
  setOption: (key, value) => set((s) => ({ options: { ...s.options, [key]: value } })),
  toggleFilters: () => set((s) => ({ showFilters: !s.showFilters })),
  setResult: (resultRoot, result) => set({ result, resultRoot, collapsed: new Set() }),
  toggleFile: (path) =>
    set((s) => {
      const collapsed = new Set(s.collapsed);
      if (collapsed.has(path)) collapsed.delete(path);
      else collapsed.add(path);
      return { collapsed };
    }),
}));
