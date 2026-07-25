import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { AnimateSpin, CheckIcon } from "neogestify-ui-components";
import { RegistryProgress } from "../../store/marketplace";

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

      <div className={`w-full rounded-full overflow-hidden bg-gray-200 dark:bg-white/10
        ${compact ? "h-1" : "h-1.5"}`}>
        {pct !== null ? (
          <div
            className="h-full rounded-full bg-linear-to-r from-blue-500 to-violet-500
              transition-[width] duration-300 ease-out"
            style={{ width: `${done ? 100 : pct}%` }}
          />
        ) : (
          // Indeterminada: no hay un total todavía, la barra solo indica actividad.
          <div className="h-full w-1/3 rounded-full bg-linear-to-r from-blue-500 to-violet-500
            animate-[cc-indeterminate_1.2s_ease-in-out_infinite]" />
        )}
      </div>

      {progress?.detail && !compact && (
        <p className="text-[11px] font-mono text-gray-400 dark:text-gray-500 truncate">
          {progress.detail}
        </p>
      )}
    </div>
  );
}
