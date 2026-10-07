import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Button, ChevronDownIcon, ChevronRightIcon, CopyIcon, DocumentIcon, EditIcon, FolderIcon,
  PasteIcon, Skeleton, Tooltip, TrashIcon,
} from "neogestify-ui-components";

import { DotsIcon, FilePlusIcon, FolderOpenIcon, FolderPlusIcon, RefreshIcon, ScissorsIcon, SendIcon } from "@/app/icons";
import { highlightAgents } from "@/features/browser/agentHighlight";
import { agentPaint } from "@/features/browser/agentPaint";
import * as ipc from "@/features/explorer/ipc";
import { canDrop, dirFor, isInside, parentDir, remapPath } from "@/features/explorer/paths";
import { buildMarkIndex, flattenTree, relativeTo, toggleExpanded, visibleWindow } from "@/features/explorer/tree";
import type { DirEntry, FileMark, RepoInfo, TreeRow } from "@/features/explorer/types";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { dropFilesOnTab, setFileDropTarget, terminalTabAt } from "@/features/terminal/fileDrop";
import { invalidateRepoInfo } from "@/features/workspaces/useRepoInfo";
import { AppDialog } from "@/shared/ui/AppDialog";
import { ContextMenu, type ContextMenuItem } from "@/shared/ui/ContextMenu";

/** Cada marca con su color. El conflicto en rojo porque es lo único que bloquea. */
export const MARK_CLASS: Record<FileMark, string> = {
  U: "text-red-500 dark:text-red-400",
  A: "text-emerald-600 dark:text-emerald-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-500 dark:text-red-400",
  "?": "text-gray-400 dark:text-white/35",
};

/** Lo copiado o cortado en el árbol. Vive fuera del componente: cambiar de tab cambia de
 *  carpeta, y copiar en un proyecto para pegar en otro es de lo más común. */
const useFileClipboard = create<{ path: string; cut: boolean } | null>(() => null);

/** Alto de cada fila, en px. Fijo: es lo que permite dibujar solo las que se ven. */
const ROW_H = 22;

/**
 * Lo leído y lo abierto de cada carpeta, fuera del componente.
 *
 * El panel se desmonta al pasar a Buscar o a Cambios, y al volver el árbol aparecía
 * colapsado y releído desde cero. Ahora vuelve como estaba y se refresca por detrás.
 */
const treeCache = new Map<string, { loaded: Map<string, DirEntry[]>; expanded: Set<string> }>();
const TREE_CACHE_MAX = 16;

function rememberTree(cwd: string, loaded: Map<string, DirEntry[]>, expanded: Set<string>) {
  treeCache.delete(cwd);
  treeCache.set(cwd, { loaded, expanded });
  if (treeCache.size > TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value!);
}

/** Cuánto esperar antes de releer las marcas de git tras un aviso: una tanda de cambios
 *  (un `npm install`, un `git checkout`) son varios avisos, y cada lectura son dos `git`. */
const REPO_REFRESH_MS = 800;

/** Cuánto hay que mover antes de que un click pase a ser un arrastre. */
const DRAG_THRESHOLD = 5;
/** Cuánto hay que quedarse sobre una carpeta cerrada, arrastrando, para que se abra. */
const HOVER_EXPAND_MS = 650;

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

type Editing =
  | { kind: "rename"; path: string }
  | { kind: "file" | "folder"; dir: string };

interface Drag {
  path: string;
  name: string;
  x: number;
  y: number;
  /** La carpeta donde caería. `null` = afuera del árbol, o un lugar que no vale. */
  target: string | null;
  copy: boolean;
  /** Afuera del árbol, sobre la terminal de un agente: se le menciona en vez de moverlo. */
  terminal: string | null;
}

/** Copiar al arrastrar: Alt en macOS, Ctrl en el resto — lo mismo que VS Code y que el
 *  gestor de archivos de cada sistema. */
const wantsCopy = (e: { ctrlKey: boolean; altKey: boolean }) => (IS_MAC ? e.altKey : e.ctrlKey);

/**
 * El campo donde se escribe el nombre, en el lugar de la fila: al crear, debajo de la
 * carpeta; al renombrar, sobre la fila misma. Enter confirma, Escape cancela y salir del
 * campo confirma — lo mismo que VS Code, donde hacer click en otro lado no tira lo escrito.
 */
function NameInput({ initial, depth, isDir, onCommit, onCancel }: {
  initial: string;
  depth: number;
  isDir: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Renombrar `app.test.ts` selecciona `app.test`: lo que se cambia casi siempre es el
    // nombre, no la extensión.
    const dot = isDir ? -1 : initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, isDir]);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = ref.current?.value.trim() ?? "";
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };

  const Icon = isDir ? FolderIcon : DocumentIcon;
  return (
    <div style={{ paddingLeft: 8 + depth * 13 }} className="flex items-center gap-1.5 h-[22px] w-full pr-2">
      <span className="w-3 shrink-0" />
      <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-white/50" />
      <input
        ref={ref}
        defaultValue={initial}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
        }}
        onBlur={() => finish(true)}
        className="flex-1 min-w-0 h-[19px] px-1 rounded-sm text-[11.5px] outline-none
          bg-white dark:bg-[#0d1520] text-gray-800 dark:text-gray-100
          border border-blue-500 dark:border-blue-400"
      />
    </div>
  );
}

/** Lo que una fila le pide al árbol. Es un objeto estable (no cambia entre dibujos), así
 *  las filas memoizadas no se redibujan solo porque el árbol se redibujó. */
interface RowActions {
  click: (entry: DirEntry) => void;
  pointerDown: (e: React.PointerEvent<HTMLButtonElement>, entry: DirEntry) => void;
  contextMenu: (e: React.MouseEvent, entry: DirEntry) => void;
}

const TreeRowButton = memo(function TreeRowButton({ entry, depth, isExpanded, mark, selected, dropHere, dimmed, openTitle, actions }: {
  entry: DirEntry;
  depth: number;
  isExpanded: boolean;
  mark: FileMark | null;
  selected: boolean;
  dropHere: boolean;
  dimmed: boolean;
  openTitle: string;
  actions: RowActions;
}) {
  // Carpeta abierta / cerrada / archivo. Que la carpeta desplegada cambie de icono no
  // duplica al chevron: el chevron dice "esto se puede plegar" y vive en la columna de la
  // jerarquía; el icono dice qué ES la fila.
  const Icon = entry.isDir ? (isExpanded ? FolderOpenIcon : FolderIcon) : DocumentIcon;
  return (
    <Button variant="custom"
      data-tree-path={entry.path}
      data-tree-dir={entry.isDir ? "1" : "0"}
      onClick={() => actions.click(entry)}
      onPointerDown={(e) => actions.pointerDown(e, entry)}
      onContextMenu={(e) => actions.contextMenu(e, entry)}
      style={{ paddingLeft: 8 + depth * 13 }}
      title={entry.isDir ? undefined : openTitle}
      className={`flex items-center gap-1.5 h-[22px] w-full pr-2 text-left
        transition-colors duration-100
        ${dimmed ? "opacity-50" : ""}
        ${dropHere
          ? "bg-blue-500/10 dark:bg-blue-400/10"
          : selected
            ? "bg-blue-500/12 dark:bg-blue-400/13"
            : "hover:bg-gray-200/50 dark:hover:bg-white/4"}`}
    >
      <span className="w-3 shrink-0 flex items-center text-gray-400 dark:text-white/30">
        {entry.isDir && (isExpanded
          ? <ChevronDownIcon className="w-2.5 h-2.5" />
          : <ChevronRightIcon className="w-2.5 h-2.5" />)}
      </span>
      {/* La carpeta va un punto más marcada que el archivo: en una lista larga es lo que
          deja separar la estructura del contenido de un vistazo, sin meter un color que
          compita con el azul de la fila seleccionada. */}
      <Icon className={`w-3.5 h-3.5 shrink-0
        ${entry.isHidden
          ? "text-gray-300 dark:text-white/20"
          : entry.isDir
            ? "text-gray-500 dark:text-white/50"
            : "text-gray-400 dark:text-white/30"}`} />
      <span className={`flex-1 min-w-0 truncate text-[11.5px]
        ${entry.isDir ? "font-semibold" : ""}
        ${entry.isHidden
          ? "text-gray-400 dark:text-white/30"
          : "text-gray-700 dark:text-gray-300"}`}>
        {entry.name}
      </span>
      {mark && (
        <span className={`shrink-0 w-3 font-mono text-[9.5px] text-center ${MARK_CLASS[mark]}`}>
          {mark}
        </span>
      )}
    </Button>
  );
});

/** Lo que se dibuja en la lista: una fila del árbol, o el campo de "nuevo" debajo de su
 *  carpeta. Las dos miden `ROW_H`. */
type ListItem = { kind: "row"; row: TreeRow } | { kind: "create" };

/**
 * El árbol de archivos del workspace. Lee un nivel por vez — recursar un repo con
 * `node_modules` tarda segundos.
 *
 * Un click en un archivo lo abre como tab, al lado de los agentes: es lo que se hace con
 * un archivo casi siempre. El click derecho tiene lo de cualquier explorador (crear,
 * renombrar, copiar, cortar, pegar, eliminar, mostrarlo en el gestor de archivos), y las
 * filas se arrastran de una carpeta a otra.
 */
export function FilesView({ cwd, repo, title }: {
  cwd: string | null;
  repo: RepoInfo | null;
  title: string;
}) {
  const { t } = useTranslation();
  const openFile = useViewTabsStore((s) => s.openFile);
  const clipboard = useFileClipboard();
  const [loaded, setLoaded] = useState<Map<string, DirEntry[]>>(() => (cwd && treeCache.get(cwd)?.loaded) || new Map());
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => (cwd && treeCache.get(cwd)?.expanded) || new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry | null } | null>(null);
  /** El segundo menú de "Enviar a un agente": a cuál, con su color. */
  const [sendMenu, setSendMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null);
  const allTabs = useTabsStore((s) => s.tabs);
  const agents = useMemo(
    () => allTabs.filter((tab) => tab.agentId !== SHELL_AGENT_ID && cwd !== null && isInside(tab.cwd, cwd)),
    [allTabs, cwd]
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<DirEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Un arrastre termina con un `click` sobre la fila: no tiene que abrirla. */
  const justDragged = useRef(false);

  const load = useCallback((dir: string, root = false) => {
    if (root) setLoading(true);
    return ipc.readDir(dir)
      .then((entries) => setLoaded((prev) => new Map(prev).set(dir, entries)))
      // Una carpeta sin permisos o recién borrada no puede tumbar el panel entero.
      .catch(() => setLoaded((prev) => new Map(prev).set(dir, [])))
      .finally(() => { if (root) setLoading(false); });
  }, []);

  // Los manejadores de un arrastre se arman al apretar y terminan después de que el
  // arrastre abrió carpetas: tienen que ver las abiertas de ahora, no las de ese momento.
  // Los avisos del observador, lo mismo.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const repoRootRef = useRef(repo?.root ?? null);
  repoRootRef.current = repo?.root ?? null;

  // Cambiar de tab cambia de carpeta: lo leído de la anterior no sirve y mantenerlo haría
  // que el árbol muestre por un instante los archivos de otro proyecto. Si esta carpeta ya
  // se había mostrado, vuelve como estaba y se relee lo visible por detrás.
  useEffect(() => {
    const cached = cwd ? treeCache.get(cwd) : undefined;
    setLoaded(cached?.loaded ?? new Map());
    setExpanded(cached?.expanded ?? new Set());
    setSelected(null);
    setEditing(null);
    if (cwd) {
      if (cached) {
        load(cwd);
        cached.expanded.forEach((dir) => { if (cached.loaded.has(dir)) load(dir); });
      } else {
        load(cwd, true);
      }
    }
    // Al irse (otra carpeta, u otra sección del panel) se guarda cómo quedó. Los refs
    // tienen el estado del último dibujo, que todavía es el de esta carpeta.
    return () => { if (cwd) rememberTree(cwd, loadedRef.current, expandedRef.current); };
  }, [cwd, load]);

  /** Releer las marcas de git, juntando los pedidos de una tanda. */
  const repoTimer = useRef<number | null>(null);
  const refreshMarks = useCallback(() => {
    if (repoTimer.current !== null) window.clearTimeout(repoTimer.current);
    repoTimer.current = window.setTimeout(() => {
      repoTimer.current = null;
      if (repoRootRef.current) invalidateRepoInfo(repoRootRef.current);
    }, REPO_REFRESH_MS);
  }, []);
  useEffect(() => () => { if (repoTimer.current !== null) window.clearTimeout(repoTimer.current); }, []);

  // Rust vigila las carpetas abiertas (cada una sin recursión) y el directorio de git, y
  // avisa qué cambió. Antes no había nada: lo que creaba un agente no aparecía hasta
  // tocar Actualizar.
  const gitDir = repo?.gitDir ?? null;
  useEffect(() => {
    if (!cwd) return;
    const dirs = [cwd, ...expanded].slice(0, 512);
    // Abrir varias carpetas seguidas (o un arrastre que las va abriendo) es una sola
    // actualización de lo vigilado.
    const timer = window.setTimeout(() => ipc.watchDirs(dirs, gitDir).catch(console.error), 80);
    return () => window.clearTimeout(timer);
  }, [cwd, expanded, gitDir]);
  useEffect(() => () => { ipc.watchDirs([], null).catch(() => {}); }, []);

  useEffect(() => {
    const label = getCurrentWindow().label;
    const unlisten = listen<ipc.ExplorerChanged>("explorer-changed", ({ payload }) => {
      if (payload.window !== label) return;
      for (const dir of payload.dirs) {
        if (dir === cwdRef.current || expandedRef.current.has(dir)) load(dir);
        // Una carpeta leída pero cerrada se olvida: se lee de nuevo al abrirla.
        else if (loadedRef.current.has(dir)) setLoaded((prev) => { const m = new Map(prev); m.delete(dir); return m; });
      }
      if (payload.git) refreshMarks();
    });
    return () => { unlisten.then((off) => off()).catch(() => {}); };
  }, [load, refreshMarks]);

  // Las marcas se indexan una vez por respuesta de git, no por fila en cada dibujo.
  const marks = useMemo(() => buildMarkIndex(repo), [repo]);
  const rows = useMemo(
    () => (cwd ? flattenTree(cwd, loaded, expanded, marks) : []),
    [cwd, loaded, expanded, marks]
  );

  const entryOf = (path: string) => rows.find((r) => r.entry.path === path)?.entry ?? null;

  /** Abre una carpeta (y la lee si hace falta) sin cerrarla si ya estaba abierta. */
  const expand = (dir: string) => {
    if (dir === cwd) return;
    setExpanded((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
    if (!loaded.has(dir)) load(dir);
  };

  const onRowClick = (entry: DirEntry) => {
    if (justDragged.current) { justDragged.current = false; return; }
    setSelected(entry.path);
    if (entry.isDir) {
      const next = toggleExpanded(expanded, entry.path);
      setExpanded(next);
      if (next.has(entry.path) && !loaded.has(entry.path)) load(entry.path);
      return;
    }
    if (cwd) openFile(cwd, entry.path);
  };

  // Refrescar vuelve a leer lo que estaba abierto, no colapsa el árbol: con tres niveles
  // desplegados, perderlos para ver un archivo nuevo que creó el agente es un castigo.
  const refresh = () => {
    if (!cwd) return;
    load(cwd, true);
    expanded.forEach((dir) => load(dir));
    refreshMarks();
  };

  /** Lo que queda después de que algo se movió o se renombró: la selección y las carpetas
   *  abiertas lo siguen, y las tabs de lo que estaba adentro también. */
  const followMove = (from: string, to: string) => {
    useViewTabsStore.getState().retargetPath(from, to);
    const next = [...expandedRef.current].map((d) => remapPath(d, from, to) ?? d);
    setExpanded(new Set(next));
    setLoaded((prev) => new Map([...prev].filter(([d]) => !isInside(d, from))));
    next.filter((d) => isInside(d, to)).forEach((d) => load(d));
    setSelected(to);
  };

  /** Corre una operación, relee las carpetas que tocó y muestra el error si falló. */
  const run = async (op: () => Promise<unknown>, dirs: string[]) => {
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(String(e));
    }
    // Se relee igual si falló: un mover a medias entre discos pudo dejar algo. Lo que no
    // está abierto se olvida, así se lee de nuevo al abrirlo en vez de mostrar lo de antes.
    for (const dir of new Set(dirs)) {
      if (dir === cwd || expandedRef.current.has(dir)) load(dir, dir === cwd);
      else setLoaded((prev) => { const m = new Map(prev); m.delete(dir); return m; });
    }
    refreshMarks();
  };

  const startCreate = (kind: "file" | "folder", dir: string) => {
    expand(dir);
    setEditing({ kind, dir });
  };

  const commitEdit = (name: string) => {
    const e = editing;
    setEditing(null);
    if (!e || !cwd) return;
    if (e.kind === "rename") {
      const dir = parentDir(e.path);
      run(async () => {
        const to = await ipc.renamePath(e.path, name);
        followMove(e.path, to);
      }, [dir]);
      return;
    }
    run(async () => {
      const path = e.kind === "file" ? await ipc.createFile(e.dir, name) : await ipc.createDir(e.dir, name);
      setSelected(path);
      // Crear un archivo es para escribirlo: se abre, como en VS Code.
      if (e.kind === "file") openFile(cwd, path);
    }, [e.dir]);
  };

  const paste = (dir: string) => {
    const clip = useFileClipboard.getState();
    if (!clip) return;
    if (!canDrop(clip.path, dir, !clip.cut)) return;
    run(async () => {
      if (clip.cut) {
        const to = await ipc.movePath(clip.path, dir);
        followMove(clip.path, to);
        useFileClipboard.setState(null, true);
      } else {
        setSelected(await ipc.copyPath(clip.path, dir));
      }
    }, [dir, parentDir(clip.path)]);
  };

  const trash = (entry: DirEntry) => {
    run(async () => {
      await ipc.trashPaths([entry.path]);
      useViewTabsStore.getState().closePath(entry.path);
      if (clipboard && isInside(clipboard.path, entry.path)) useFileClipboard.setState(null, true);
      setSelected(null);
    }, [parentDir(entry.path)]);
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch((e) => setError(String(e)));
  };

  const menuItems = (entry: DirEntry | null): ContextMenuItem[] => {
    if (!cwd) return [];
    const dir = entry ? dirFor(entry) : cwd;
    const path = entry?.path ?? cwd;
    const pasteOk = clipboard !== null && canDrop(clipboard.path, dir, !clipboard.cut);
    const create: ContextMenuItem[] = [
      { key: "newFile", label: t("explorer.menu.newFile"), icon: <FilePlusIcon className="w-4 h-4" />, onSelect: () => startCreate("file", dir) },
      { key: "newFolder", label: t("explorer.menu.newFolder"), icon: <FolderPlusIcon className="w-4 h-4" />, onSelect: () => startCreate("folder", dir) },
      { key: "reveal", label: t("explorer.reveal"), icon: <FolderOpenIcon className="w-4 h-4" />, separator: true, onSelect: () => { revealItemInDir(path).catch((e) => setError(String(e))); } },
    ];
    const pasteItem: ContextMenuItem = {
      key: "paste", label: t("explorer.menu.paste"), icon: <PasteIcon className="w-4 h-4" />, hint: `${MOD}V`,
      disabled: !pasteOk, onSelect: () => paste(dir),
    };
    if (!entry) {
      return [
        ...create,
        { ...pasteItem, separator: true },
        { key: "copyPath", label: t("explorer.menu.copyPath"), icon: <CopyIcon className="w-4 h-4" />, separator: true, onSelect: () => copyText(cwd) },
        { key: "refresh", label: t("explorer.refresh"), icon: <RefreshIcon className="w-4 h-4" />, onSelect: refresh },
      ];
    }
    return [
      ...create,
      { key: "cut", label: t("explorer.menu.cut"), icon: <ScissorsIcon className="w-4 h-4" />, hint: `${MOD}X`, separator: true, onSelect: () => useFileClipboard.setState({ path: entry.path, cut: true }, true) },
      { key: "copy", label: t("explorer.menu.copy"), icon: <CopyIcon className="w-4 h-4" />, hint: `${MOD}C`, onSelect: () => useFileClipboard.setState({ path: entry.path, cut: false }, true) },
      pasteItem,
      { key: "copyPath", label: t("explorer.menu.copyPath"), separator: true, hint: IS_MAC ? "⌥⌘C" : "Shift+Alt+C", onSelect: () => copyText(entry.path) },
      { key: "copyRel", label: t("explorer.menu.copyRelativePath"), onSelect: () => copyText(relativeTo(cwd, entry.path) ?? entry.path) },
      {
        key: "send",
        label: t("explorer.menu.sendTo"),
        icon: <SendIcon className="w-4 h-4" />,
        separator: true,
        disabled: agents.length === 0,
        onSelect: () => setSendMenu({ x: menu?.x ?? 0, y: menu?.y ?? 0, entry }),
      },
      { key: "rename", label: t("explorer.menu.rename"), icon: <EditIcon className="w-4 h-4" />, hint: IS_MAC ? "↵" : "F2", separator: true, onSelect: () => setEditing({ kind: "rename", path: entry.path }) },
      { key: "delete", label: t("explorer.menu.delete"), icon: <TrashIcon className="w-4 h-4" />, hint: IS_MAC ? "⌘⌫" : "Supr", danger: true, onSelect: () => setDeleting(entry) },
    ];
  };

  /** Se pega la mención en la entrada del agente, sin mandarla: lo que se quiere es
   *  preguntarle algo sobre ese archivo, y la pregunta la escribe la persona. */
  // Mientras está abierta la lista, cada tab de agente se pinta de su color: la fila y la
  // tab se ven iguales, y "¿cuál es este Claude Code?" se contesta mirando arriba.
  useEffect(() => {
    if (!sendMenu) return;
    highlightAgents(agents.map((tab) => tab.id));
    return () => highlightAgents([]);
  }, [sendMenu, agents]);

  const sendTo = (tabId: string, entry: DirEntry) => {
    if (!dropFilesOnTab(tabId, [{ path: entry.path, isDir: entry.isDir }])) setError(t("forge.agent.notRunning"));
  };

  const sendItems = (entry: DirEntry): ContextMenuItem[] =>
    agents.map((tab) => ({
      key: tab.id,
      label: tab.title,
      // El mismo color que la tab del agente cuando maneja un navegador: se elige mirando.
      icon: <span className={`m-auto w-2.5 h-2.5 rounded-full ${agentPaint(tab.id).strip}`} />,
      onSelect: () => sendTo(tab.id, entry),
    }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !cwd) return;
    const entry = selected ? entryOf(selected) : null;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    // Por `code` y no por `key`: con Alt, en macOS la C llega como "ç".
    const key = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : "";
    const copyPathCombo = IS_MAC ? e.metaKey && e.altKey : e.shiftKey && e.altKey;
    let handled = true;
    if (entry && (e.key === "F2" || (IS_MAC && e.key === "Enter"))) setEditing({ kind: "rename", path: entry.path });
    else if (entry && (e.key === "Delete" || (IS_MAC && e.metaKey && e.key === "Backspace"))) setDeleting(entry);
    else if (entry && copyPathCombo && key === "c") copyText(entry.path);
    else if (entry && mod && key === "c") useFileClipboard.setState({ path: entry.path, cut: false }, true);
    else if (entry && mod && key === "x") useFileClipboard.setState({ path: entry.path, cut: true }, true);
    else if (mod && key === "v") paste(entry ? dirFor(entry) : cwd);
    else if (e.key === "Escape" && clipboard) useFileClipboard.setState(null, true);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  // ── Arrastrar ────────────────────────────────────────────────────────────────────────
  //
  // Con el puntero y no con el drag & drop de HTML, por lo mismo que las tabs (ver
  // `tabDrag.ts`): en Windows Tauri se queda con los arrastres de la ventana para recibir
  // archivos, y la página no ve ninguno.

  const hoverTimer = useRef<{ dir: string; id: number } | null>(null);
  const clearHover = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current.id);
    hoverTimer.current = null;
  };

  /** La carpeta bajo el puntero: la fila misma si es carpeta, la de su archivo si no, y la
   *  raíz si está sobre el árbol pero no sobre una fila. */
  const dropDirAt = (x: number, y: number): { dir: string; row: HTMLElement | null } | null => {
    const el = document.elementFromPoint(x, y);
    if (!el || !listRef.current?.contains(el) || !cwd) return null;
    const row = el.closest<HTMLElement>("[data-tree-path]");
    if (!row) return { dir: cwd, row: null };
    const path = row.dataset.treePath ?? "";
    return { dir: row.dataset.treeDir === "1" ? path : parentDir(path), row };
  };

  const onRowPointerDown = (e: React.PointerEvent<HTMLButtonElement>, entry: DirEntry) => {
    if (e.button !== 0 || editing) return;
    const el = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let last: Drag | null = null;

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        dragging = true;
        try { el.setPointerCapture(ev.pointerId); } catch { /* la fila ya no está */ }
      }
      const copy = wantsCopy(ev);
      const hit = dropDirAt(ev.clientX, ev.clientY);
      const target = hit && canDrop(entry.path, hit.dir, copy) ? hit.dir : null;
      const terminal = hit ? null : terminalTabAt(ev.clientX, ev.clientY);
      setFileDropTarget(terminal);

      // Quedarse sobre una carpeta cerrada la abre: si no, soltar en una subcarpeta que no
      // se ve obligaría a abrirla antes de empezar a arrastrar.
      const over = hit?.row?.dataset.treeDir === "1" ? hit.row.dataset.treePath ?? null : null;
      if (over !== hoverTimer.current?.dir) {
        clearHover();
        if (over) hoverTimer.current = { dir: over, id: window.setTimeout(() => expand(over), HOVER_EXPAND_MS) };
      }

      last = { path: entry.path, name: entry.name, x: ev.clientX, y: ev.clientY, target, copy, terminal };
      setDrag(last);
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      clearHover();
      setFileDropTarget(null);
      if (!dragging) return;
      justDragged.current = true;
      // Si el `click` no llega (se soltó fuera de la fila), que no quede armado.
      window.setTimeout(() => { justDragged.current = false; }, 0);
      setDrag(null);
      const done = last;
      if (ev.type !== "pointercancel" && done?.terminal) {
        if (!dropFilesOnTab(done.terminal, [{ path: done.path, isDir: entry.isDir }])) {
          setError(t("forge.agent.notRunning"));
        }
        return;
      }
      if (ev.type === "pointercancel" || !done?.target) return;
      const dir = done.target;
      const copy = wantsCopy(ev);
      run(async () => {
        if (copy) {
          setSelected(await ipc.copyPath(done.path, dir));
        } else {
          const to = await ipc.movePath(done.path, dir);
          followMove(done.path, to);
        }
      }, [dir, parentDir(done.path)]);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  useEffect(() => clearHover, []);

  const onRowContextMenu = (e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(entry.path);
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // Las filas reciben siempre el mismo objeto y este llama a lo de este dibujo.
  const actionsRef = useRef({ click: onRowClick, pointerDown: onRowPointerDown, contextMenu: onRowContextMenu });
  actionsRef.current = { click: onRowClick, pointerDown: onRowPointerDown, contextMenu: onRowContextMenu };
  const actions = useMemo<RowActions>(() => ({
    click: (entry) => actionsRef.current.click(entry),
    pointerDown: (e, entry) => actionsRef.current.pointerDown(e, entry),
    contextMenu: (e, entry) => actionsRef.current.contextMenu(e, entry),
  }), []);

  // ── Dibujo ───────────────────────────────────────────────────────────────────────────

  /** Dónde va el campo de "nuevo": primera fila adentro de su carpeta. */
  const creating = editing && editing.kind !== "rename" ? editing : null;
  const createDepth = creating
    ? creating.dir === cwd ? 0 : (rows.find((r) => r.entry.path === creating.dir)?.depth ?? -1) + 1
    : 0;

  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = [];
    if (creating && creating.dir === cwd) out.push({ kind: "create" });
    for (const row of rows) {
      out.push({ kind: "row", row });
      if (creating && creating.dir === row.entry.path && row.isExpanded) out.push({ kind: "create" });
    }
    return out;
  }, [rows, creating, cwd]);

  // Solo se dibujan las filas que se ven (más un margen): un `node_modules` abierto son
  // miles, y dibujarlas todas hacía que el panel tardara en abrir carpetas y en desplazarse.
  const [view, setView] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scrollFrame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) setView((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }));
    });
  };
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  const { start, end } = visibleWindow(view.top, view.height, items.length, ROW_H);

  // Lo que se está nombrando tiene que estar a la vista: con la lista recortada, un campo
  // fuera de la ventana ni siquiera se dibuja y no tomaría el foco.
  const editKey = editing ? (editing.kind === "rename" ? editing.path : `new:${editing.dir}`) : null;
  useEffect(() => {
    const el = listRef.current;
    if (!editKey || !el) return;
    const index = items.findIndex((item) =>
      editing?.kind === "rename" ? item.kind === "row" && item.row.entry.path === editing.path : item.kind === "create");
    if (index < 0) return;
    const top = index * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
      setView((v) => ({ ...v, top: el.scrollTop }));
    }
    // Solo al empezar a editar: `items` cambia mientras tanto y no hay que perseguirlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey]);

  const createInput = creating && (
    <NameInput
      key="__new"
      initial=""
      depth={createDepth}
      isDir={creating.kind === "folder"}
      onCommit={commitEdit}
      onCancel={() => setEditing(null)}
    />
  );

  return (
    <>
      <div className="flex items-center gap-2 h-8 shrink-0 pl-3.5 pr-1.5
        bg-gray-100/60 dark:bg-white/2">
        <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold tracking-tight
          text-gray-800 dark:text-gray-200">
          {title}
        </span>
        {[
          { label: "explorer.menu.newFile", Icon: FilePlusIcon, onClick: () => cwd && startCreate("file", selected ? dirFor(entryOf(selected) ?? { path: cwd, isDir: true }) : cwd) },
          { label: "explorer.menu.newFolder", Icon: FolderPlusIcon, onClick: () => cwd && startCreate("folder", selected ? dirFor(entryOf(selected) ?? { path: cwd, isDir: true }) : cwd) },
          { label: "explorer.refresh", Icon: RefreshIcon, onClick: refresh },
        ].map(({ label, Icon, onClick }) => (
          <Tooltip key={label} content={t(label)} placement="bottom">
            <Button variant="icon"
              onClick={onClick}
              disabled={!cwd}
              aria-label={t(label)}
              className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
                text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
                hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 p-0"
            >
              <Icon className="w-3.5 h-3.5" />
            </Button>
          </Tooltip>
        ))}
        <Tooltip content={t("explorer.more")} placement="bottom">
          <Button variant="icon"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4, entry: selected ? entryOf(selected) : null });
            }}
            disabled={!cwd}
            aria-label={t("explorer.more")}
            className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
              text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 p-0"
          >
            <DotsIcon className="w-3.5 h-3.5" />
          </Button>
        </Tooltip>
      </div>

      <div
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onContextMenu={(e) => {
          e.preventDefault();
          if (cwd) setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
        className={`flex-1 min-h-0 cc-scroll py-1 outline-none
          ${drag?.target === cwd ? "bg-blue-500/6 dark:bg-blue-400/6" : ""}`}
      >
        {loading && rows.length === 0 ? (
          <div className="flex flex-col gap-1.5 px-3.5 py-2">
            {[64, 48, 72, 40, 56, 68].map((w, i) => (
              <Skeleton key={i} variant="text" height={12} width={`${w}%`} />
            ))}
          </div>
        ) : !cwd ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-gray-400 dark:text-white/30">
            {t("explorer.noTab")}
          </p>
        ) : (
          <>
            <div style={{ height: start * ROW_H }} />
            {items.slice(start, end).map((item) => {
              if (item.kind === "create") return createInput;
              const { entry, depth, isExpanded, mark } = item.row;
              if (editing?.kind === "rename" && editing.path === entry.path) {
                return (
                  <NameInput
                    key={entry.path}
                    initial={entry.name}
                    depth={depth}
                    isDir={entry.isDir}
                    onCommit={commitEdit}
                    onCancel={() => setEditing(null)}
                  />
                );
              }
              return (
                <TreeRowButton
                  key={entry.path}
                  entry={entry}
                  depth={depth}
                  isExpanded={isExpanded}
                  mark={mark}
                  selected={selected === entry.path}
                  dropHere={drag?.target != null && drag.target !== cwd && isInside(entry.path, drag.target)}
                  dimmed={(clipboard?.cut === true && isInside(entry.path, clipboard.path)) || drag?.path === entry.path}
                  openTitle={t("explorer.openFile")}
                  actions={actions}
                />
              );
            })}
            <div style={{ height: (items.length - end) * ROW_H }} />
          </>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 shrink-0 px-3 py-2 text-[11px]
          border-t border-red-200 dark:border-red-500/20
          bg-red-50 dark:bg-red-500/8 text-red-600 dark:text-red-400">
          <span className="flex-1 min-w-0 break-words">{error}</span>
          <Button variant="custom" onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100 inline-block">
            {t("btn.close")}
          </Button>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems(menu.entry)} />
      )}

      {sendMenu && (
        <ContextMenu x={sendMenu.x} y={sendMenu.y} onClose={() => setSendMenu(null)} items={sendItems(sendMenu.entry)} />
      )}

      {deleting && (
        <AppDialog
          title={t("explorer.delete.title", { name: deleting.name })}
          size="sm"
          closeOnEsc
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>{t("btn.cancel")}</Button>
              <Button
                variant="danger"
                autoFocus
                onClick={() => { trash(deleting); setDeleting(null); }}
              >
                {t("explorer.delete.confirm")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t(deleting.isDir ? "explorer.delete.bodyFolder" : "explorer.delete.body")}
          </p>
        </AppDialog>
      )}

      {drag && createPortal(
        <div
          style={{ left: drag.x + 12, top: drag.y + 10 }}
          className="fixed z-[10000] pointer-events-none flex items-center gap-1.5 px-2 py-1 rounded-md
            text-[11px] shadow-lg border
            bg-white dark:bg-gray-800 border-gray-200 dark:border-white/10
            text-gray-700 dark:text-gray-200"
        >
          {drag.copy && drag.target && <span className="font-bold text-emerald-500">+</span>}
          {drag.terminal && <span className="font-bold text-blue-500">@</span>}
          <span className={drag.target || drag.terminal ? "" : "opacity-50"}>{drag.name}</span>
        </div>,
        document.body
      )}
    </>
  );
}
