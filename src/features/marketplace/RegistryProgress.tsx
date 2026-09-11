import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { AnimateSpin, CheckIcon, Progress } from "neogestify-ui-components";
import type { RegistryProgress } from "@/features/marketplace/types";

/**
 * Último evento `cc-registry-progress` de este registry, o `null` si todavía no llegó
 * ninguno. Se resetea cuando `active` pasa a `false` para que un refresh nuevo no arranque
 * mostrando el resultado del anterior.
 */
export function useRegistryProgress(registryId: string, active: boolean): RegistryProgress | null {
  const [progress, setProgress] = useState<RegistryProgress | null>(null);

  useEffect(() => {
    if (!active) { setProgress(null); return; }
    const unlisten = listen<RegistryProgress>("cc-registry-progress", (e) => {
      if (e.payload.registryId === registryId) setProgress(e.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [registryId, active]);

  return progress;
}

interface RegistryProgressBarProps {
  progress: RegistryProgress | null;
  /** `compact` es la variante que va dentro de una fila de la lista de repos. */
  compact?: boolean;
}

/**
 * Estado de la resolución de un repo. Las fases de red no son contables (no se sabe
 * cuántos archivos hay hasta tener el árbol del repo), así que hasta que llega un `total`
 * se muestra una barra indeterminada; a partir de ahí, el porcentaje real.
 */
export function RegistryProgressBar({ progress, compact = false }: RegistryProgressBarProps) {
  const { t } = useTranslation();

  const phase = progress?.phase ?? "connecting";
  const total = progress?.total ?? null;
  const pct = total && total > 0 ? Math.round(((progress?.current ?? 0) / total) * 100) : null;
  const done = phase === "done";

  return (
    <div className={`flex flex-col ${compact ? "gap-1" : "gap-2"}`}>
      <div className={`flex items-center gap-2 text-gray-600 dark:text-gray-300
        ${compact ? "text-[11px]" : "text-xs"}`}>
        {done
          ? <CheckIcon className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
          : <AnimateSpin className="w-3.5 h-3.5 text-blue-500 shrink-0" />}
        <span className="font-medium truncate">{t(`marketplace.add.phase.${phase}`)}</span>
        {pct !== null && (
          <span className="ml-auto font-mono tabular-nums text-gray-400 dark:text-gray-500 shrink-0">
            {pct}%
          </span>
        )}
      </div>

      {/* La barra es la de la librería: trae el estado indeterminado, respeta
          `prefers-reduced-motion` y se mueve con los mismos tiempos que el resto. */}
      <Progress
        value={done ? 100 : (pct ?? 0)}
        max={100}
        size={compact ? "xs" : "sm"}
        variant={done ? "success" : "accent"}
        indeterminate={pct === null && !done}
      />

      {progress?.detail && !compact && (
        <p className="text-[11px] font-mono text-gray-400 dark:text-gray-500 truncate">
          {progress.detail}
        </p>
      )}
    </div>
  );
}
