import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, CheckCircleIcon } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";

import { agentSearchPath, detectAgents, type SearchPath } from "./ipc";

/** La terminal pelada no es una TUI que se instale: no tiene sentido listarla acá. */
const SHELL_AGENT_ID = "bash";

/**
 * Qué TUIs de fábrica encontró la app en esta máquina, dónde, y dónde buscó.
 *
 * Existe porque "anda en mi terminal pero no aparece en la app" no tenía cómo
 * diagnosticarse: la app busca en SU PATH, que no es el de la terminal (ver
 * `src-tauri/src/util/path_env.rs`). Acá se ve qué encontró, qué le aportó el shell del
 * usuario, y se puede volver a buscar sin reiniciar — que es lo que hace falta después de
 * instalar una TUI con la app abierta.
 */
export function DetectedAgents() {
  const { t } = useTranslation();
  const detected = useTabsStore((s) => s.detectedAgents);
  const setDetectedAgents = useTabsStore((s) => s.setDetectedAgents);
  const [searchPath, setSearchPath] = useState<SearchPath | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showPath, setShowPath] = useState(false);

  useEffect(() => {
    agentSearchPath().then(setSearchPath).catch(() => setSearchPath(null));
  }, []);

  const rescan = async () => {
    setScanning(true);
    try {
      setDetectedAgents(await detectAgents());
    } finally {
      setScanning(false);
    }
  };

  const agents = detected.filter((a) => a.id !== SHELL_AGENT_ID);
  // Que falte alguna es lo normal —casi nadie tiene las cinco—, así que eso solo no abre la
  // explicación. Lo que sí la abre sola es que el shell no haya contestado: ahí la app
  // busca con menos de lo que ve la terminal, y conviene saberlo sin tener que ir a buscarlo.
  const shellFailed = searchPath !== null && searchPath.shell !== null && !searchPath.shellOk;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide
          text-gray-400 dark:text-white/30">
          {t("settings.tuis.detected")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={rescan}
          disabled={scanning}
          leftIcon={scanning ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
        >
          {t("settings.tuis.rescan")}
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        {agents.map((agent) => (
          <div key={agent.id} className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg
            bg-gray-100/70 dark:bg-white/4">
            {agent.available ? (
              <CheckCircleIcon className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
            ) : (
              <span className="w-1.5 h-1.5 mx-1 rounded-full shrink-0 bg-gray-300 dark:bg-white/20" />
            )}
            <span className="w-28 shrink-0 truncate text-[12px] text-gray-800 dark:text-gray-100">
              {agent.label}
            </span>
            <span className={`flex-1 min-w-0 truncate text-[10.5px] text-gray-400 dark:text-white/35
              ${agent.available ? "font-mono" : ""}`}>
              {agent.available
                ? agent.path ?? agent.command
                : t("settings.tuis.notFound", { command: agent.command })}
            </span>
            {agent.version && (
              <span className="shrink-0 max-w-40 truncate text-[10.5px] text-gray-400 dark:text-white/35">
                {agent.version}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Cuando falta alguna, lo que sirve es saber dónde se buscó: la carpeta donde la
          instalaste tiene que estar en esta lista. */}
      {searchPath && (
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => setShowPath((v) => !v)}
            className="cc-t self-start text-[10.5px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            {showPath ? t("settings.tuis.path.hide") : t("settings.tuis.path.show")}
          </button>

          {(showPath || shellFailed) && (
            <p className="text-[10.5px] leading-relaxed text-gray-500 dark:text-white/40">
              {searchPath.shell === null
                ? t("settings.tuis.path.windows")
                : searchPath.shellOk
                  ? t("settings.tuis.path.shellOk", { shell: searchPath.shell, count: searchPath.fromShell.length })
                  : t("settings.tuis.path.shellFailed", { shell: searchPath.shell, error: searchPath.shellError ?? "" })}
              {` ${t("settings.tuis.path.hint")}`}
            </p>
          )}

          {showPath && (
            <div className="flex flex-col gap-px max-h-48 overflow-auto cc-scroll px-3 py-2 rounded-lg
              bg-gray-100/70 dark:bg-white/4">
              {searchPath.effective.map((dir) => (
                <span key={dir} className="flex items-center gap-2 font-mono text-[10.5px]
                  text-gray-600 dark:text-gray-300">
                  <span className="truncate">{dir}</span>
                  {searchPath.fromShell.includes(dir) && (
                    <span className="shrink-0 text-[9.5px] text-emerald-600 dark:text-emerald-400">
                      {t("settings.tuis.path.fromShell")}
                    </span>
                  )}
                  {searchPath.known.includes(dir) && (
                    <span className="shrink-0 text-[9.5px] text-gray-400 dark:text-white/30">
                      {t("settings.tuis.path.known")}
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
