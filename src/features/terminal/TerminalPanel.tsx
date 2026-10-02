import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Terminal } from "@/features/terminal/Terminal";
import { useTabsStore } from "@/features/tabs/store";
import { focusGroup, placeStyle, usePlacements, type Rect } from "@/features/tabs/layout/layoutStore";
import { agentKey } from "@/features/tabs/layout/layoutTree";
import { buildResumeCommand, isResumable } from "@/features/sessions/agentResume";
import { readDir } from "@/features/explorer/ipc";
import {
  dropFilesOnTab, setFileDropTarget, terminalTabAt, TERMINAL_TAB_ATTR, useFileDropTarget,
} from "@/features/terminal/fileDrop";

export function TerminalPanel() {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const setPtyId = useTabsStore((s) => s.setPtyId);
  const setSessionId = useTabsStore((s) => s.setSessionId);
  // El panel sigue montado (para no matar los PTYs) pero oculto fuera de /workspace, así
  // que "ser la tab activa" no alcanza para enfocar: en Skills o Settings el foco tiene que
  // quedarse en esa página, no robárselo una terminal invisible.
  const onWorkspace = useLocation().pathname.startsWith("/workspace");
  // Con la pantalla dividida se ven varias, pero el teclado va a una sola: la del grupo
  // enfocado. Si ahí hay un archivo o un navegador, a ninguna terminal.
  const { visible, focusedItem } = usePlacements();
  // Una oculta se queda con el último lugar que tuvo: cambiarle el tamaño sin que se vea le
  // mandaría a su TUI un resize para nada, y otro al volver a mostrarse.
  const lastRect = useRef(new Map<string, Rect | null>());
  const dropTarget = useFileDropTarget((s) => s.tabId);

  // Archivos soltados desde el gestor de archivos del sistema. El webview no los ve como
  // un drop de HTML: Tauri se queda con el arrastre de la ventana (en Windows, siempre) y
  // avisa con las rutas y la posición, en píxeles físicos.
  useEffect(() => {
    if (!onWorkspace) return;
    const at = (p: { x: number; y: number }) =>
      terminalTabAt(p.x / window.devicePixelRatio, p.y / window.devicePixelRatio);
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        setFileDropTarget(null);
        return;
      }
      const tabId = at(payload.position);
      if (payload.type !== "drop") {
        setFileDropTarget(tabId);
        return;
      }
      setFileDropTarget(null);
      if (!tabId || payload.paths.length === 0) return;
      // Si es carpeta no viene dicho: se pregunta, para que la mención termine en `/`.
      Promise.all(payload.paths.map((path) => readDir(path).then(() => true, () => false)))
        .then((dirs) => dropFilesOnTab(tabId, payload.paths.map((path, i) => ({ path, isDir: dirs[i] }))))
        .catch(console.error);
    });
    // Si además el webview recibe el drop (según el sistema, le llega igual), lo suelta en
    // el textarea de xterm como texto: la ruta del gestor de archivos, citada
    // (`'/home/…/a.ts'`). Sobre una terminal no se deja: lo que se escribe es la mención.
    const swallow = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      if (!types.includes("Files") && !types.includes("text/uri-list")) return;
      if (!(e.target instanceof Element) || !e.target.closest(`[${TERMINAL_TAB_ATTR}]`)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("dragover", swallow, true);
    window.addEventListener("drop", swallow, true);
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
      window.removeEventListener("dragover", swallow, true);
      window.removeEventListener("drop", swallow, true);
      setFileDropTarget(null);
    };
  }, [onWorkspace]);

  return (
    // h-full en lugar de flex-1: el padre es position:absolute;inset:0 (no flex),
    // así que h-full es la única forma de darle altura real al panel.
    <div className="relative h-full w-full overflow-hidden bg-gray-100 dark:bg-[#0d1117]">
      {tabs.map((tab) => {
        // El resume del agente ya reconstruye su propia conversación; reproducir
        // también el scrollback crudo aquí duplicaría/ensuciaría la salida.
        const isResuming = !!tab.sessionId && isResumable(tab.agentId);
        const key = agentKey(tab.id);
        const placement = visible.get(key);
        if (placement) lastRect.current.set(key, placement.rect);
        const shown = placement !== undefined;
        return (
          <div
            key={tab.id}
            style={{
              ...placeStyle(lastRect.current.get(key) ?? null),
              // Sin "visible" explícito: así hereda el visibility del contenedor de
              // AppShell (que lo oculta fuera de /workspace) en vez de sobreescribirlo.
              visibility: shown ? undefined : "hidden",
              pointerEvents: shown ? "auto" : "none",
              zIndex: shown ? 1 : 0,
            }}
            {...{ [TERMINAL_TAB_ATTR]: tab.id }}
            onPointerDownCapture={() => placement?.groupId && focusGroup(placement.groupId)}
          >
            {dropTarget === tab.id && (
              <div className="absolute inset-1 z-10 pointer-events-none flex items-end justify-center pb-6
                rounded-lg border-2 border-dashed border-blue-500/70 bg-blue-500/8">
                <span className="px-3 py-1.5 rounded-md text-[12px] font-medium shadow-lg
                  bg-blue-600 text-white">
                  {t("terminal.dropHint")}
                </span>
              </div>
            )}
            <Terminal
              // El nonce en la key: reiniciar el agente desmonta esta terminal (lo que mata
              // su proceso) y monta otra, que relanza con `--resume`.
              key={`${tab.id}:${tab.restartNonce ?? 0}`}
              tabId={tab.id}
              command={buildResumeCommand(tab.agentId, tab.command, tab.sessionId)}
              cwd={tab.cwd}
              agentId={tab.agentId}
              accountId={tab.accountId}
              prelaunch={tab.prelaunch}
              attachPtyId={tab.ptyId ?? undefined}
              initialScrollback={isResuming ? undefined : tab.scrollback}
              isActive={key === focusedItem && onWorkspace}
              isVisible={shown}
              openedAt={tab.openedAt}
              knownSessionId={tab.sessionId}
              onReady={(ptyId) => setPtyId(tab.id, ptyId)}
              onSessionDiscovered={(sessionId) => setSessionId(tab.id, sessionId)}
            />
          </div>
        );
      })}

      {tabs.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 dark:text-white/20">
          <span className="text-5xl select-none">⌥</span>
          <p className="text-sm">{t("terminal.empty")}</p>
        </div>
      )}
    </div>
  );
}
