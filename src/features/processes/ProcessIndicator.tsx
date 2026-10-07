import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";

import { useProcessesStore } from "./store";
import { visibleProcesses } from "./types";

/** Cuántos subprocesos del workspace actual están corriendo. */
export function useRunningHere(): number {
  const procs = useProcessesStore((s) => s.procs);
  const workspace = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? null);
  return visibleProcesses(procs, workspace, false).filter((p) => p.status === "running").length;
}

/**
 * Los subprocesos del workspace, en la barra de estado: que un servidor que lanzó un agente
 * siga corriendo (y consumiendo) se ve desde cualquier lado. Desaparece si no hay ninguno.
 */
export function ProcessIndicator() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const running = useRunningHere();
  if (running === 0) return null;
  return (
    <>
      <span className="w-px h-3 bg-gray-300 dark:bg-white/10" />
      <Button variant="custom"
        onClick={() => navigate("/processes")}
        title={t("processes.indicator.hint")}
        className="cc-t flex items-center gap-1 px-1.5 h-[18px] rounded hover:bg-gray-200 dark:hover:bg-white/8"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        {t("processes.indicator.running", { count: running })}
      </Button>
    </>
  );
}
