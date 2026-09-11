import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch, Tooltip } from "neogestify-ui-components";
import { EditIcon, TrashIcon, CloudIcon, FolderIcon, AnimateSpin, IconReset } from "neogestify-ui-components";
import { RegistryProgressBar, useRegistryProgress } from "@/features/marketplace/RegistryProgress";
import { useMarketplaceStore } from "@/features/marketplace/store";
import type { RegistrySummary } from "@/features/marketplace/types";
import { RemoveRegistryDialog } from "@/features/marketplace/RemoveRegistryDialog";

function timeAgo(ts: number | null): string {
  if (ts == null) return "";
  const diffS = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diffS < 60) return `${diffS}s`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h`;
  return `${Math.floor(diffS / 86400)}d`;
}

interface RegistryRowProps {
  registry: RegistrySummary;
}

export function RegistryRow({ registry: r }: RegistryRowProps) {
  const { t } = useTranslation();
  const refreshingId = useMarketplaceStore((s) => s.refreshingId);
  const refreshRegistry = useMarketplaceStore((s) => s.refreshRegistry);
  const setRegistryEnabled = useMarketplaceStore((s) => s.setRegistryEnabled);
  const renameRegistry = useMarketplaceStore((s) => s.renameRegistry);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(r.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const refreshing = refreshingId === r.id;
  const progress = useRegistryProgress(r.id, refreshing);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commitRename = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== r.name) renameRegistry(r.id, trimmed);
    else setNameDraft(r.name);
    setEditing(false);
  };

  // Borrar un repo se lleva sus skills, así que la confirmación no puede ser un sí/no
  // genérico: `RemoveRegistryDialog` las lista antes de dejar seguir.
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Todo lo que no sea una carpeta del disco viene de la red.
  const SourceIcon = r.sourceType === "local" ? FolderIcon : CloudIcon;

  return (
    <li className="cc-t flex flex-col px-3 py-2 hover:bg-gray-100/70 dark:hover:bg-white/3">
      <div className="flex items-center gap-2.5">
        <span className="flex items-center justify-center w-6 h-6 rounded-md shrink-0
          bg-gray-100 dark:bg-white/8 text-gray-500 dark:text-gray-400">
          <SourceIcon className="w-3.5 h-3.5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 group/name">
            {editing ? (
              <input
                ref={inputRef}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") { setNameDraft(r.name); setEditing(false); }
                }}
                className="min-w-0 max-w-[16rem] bg-transparent outline-none
                  border-b border-blue-400 text-[12.5px] font-semibold
                  text-gray-900 dark:text-white"
              />
            ) : (
              <>
                <span className="truncate text-[12.5px] font-semibold
                  text-gray-800 dark:text-gray-100">
                  {r.name}
                </span>
                <button
                  onClick={() => { setNameDraft(r.name); setEditing(true); }}
                  title={t("marketplace.registries.rename")}
                  className="cc-t shrink-0 opacity-0 group-hover/name:opacity-100
                    text-gray-400 hover:text-gray-700 dark:hover:text-white"
                >
                  <EditIcon className="w-3 h-3" />
                </button>
              </>
            )}
            <span className="shrink-0 px-1.5 rounded-full font-mono text-[9.5px]
              bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/40">
              {r.sourceType}
            </span>
          </div>

          {/* Un repo de skills.sh sin filtro no tiene ubicación que mostrar; sin esto la
              línea queda vacía y parece un dato que falta. */}
          <p className="truncate font-mono text-[10.5px] text-gray-400 dark:text-white/35">
            {r.location || t("marketplace.registries.wholeDirectory")}
          </p>

          {r.error ? (
            <p className="truncate text-[10.5px] text-red-500 dark:text-red-400">{r.error}</p>
          ) : (
            <p className="text-[10.5px] tabular-nums text-gray-400 dark:text-white/30">
              {r.lastFetched != null
                ? `${t("marketplace.registries.skillCount", { count: r.skillCount })} · ${t("marketplace.registries.fetchedAgo", { time: timeAgo(r.lastFetched) })}`
                : t("marketplace.registries.neverFetched")}
            </p>
          )}

          {/* Un repositorio en 0 normalmente significa "vacío o roto"; acá no. skills.sh no
              expone forma de enumerar su catálogo (solo responde a búsquedas), así que
              refrescarlo NUNCA le va a subir el conteo, y sin decirlo parece un repositorio
              defectuoso. Se muestra siempre, no solo en 0: es una propiedad de la fuente, y
              el número que llegue a haber es el de la última búsqueda, no su tamaño real. */}
          {r.sourceType === "skillssh" && (
            <p className="text-[10.5px] text-amber-600 dark:text-amber-400/80">
              {t("marketplace.registries.skillsShNotListable")}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Switch
            checked={r.enabled}
            onChange={(enabled) => setRegistryEnabled(r.id, enabled)}
            size="sm"
            aria-label={r.enabled ? t("marketplace.registries.enabled") : t("marketplace.registries.disabled")}
          />
          <Tooltip content={t("marketplace.registries.refresh")} placement="bottom">
            <button
              onClick={() => refreshRegistry(r.id)}
              disabled={refreshing}
              aria-label={t("marketplace.registries.refresh")}
              className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
                text-gray-400 dark:text-white/35
                hover:text-gray-700 dark:hover:text-white
                hover:bg-gray-200 dark:hover:bg-white/10
                disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {refreshing ? <AnimateSpin className="w-3.5 h-3.5" /> : <IconReset className="w-3.5 h-3.5" />}
            </button>
          </Tooltip>
          <Tooltip content={t("marketplace.registries.remove")} placement="bottom">
            <button
              onClick={() => setConfirmRemove(true)}
              aria-label={t("marketplace.registries.remove")}
              className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
                text-gray-400 dark:text-white/35
                hover:text-red-500 dark:hover:text-red-400
                hover:bg-gray-200 dark:hover:bg-white/10"
            >
              <TrashIcon className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Debajo de la fila (no al costado) para que la barra ocupe todo el ancho: un repo
          grande son decenas de requests y el porcentaje es lo que dice si vale la pena esperar. */}
      {refreshing && (
        <div className="mt-1.5 pl-8.5">
          <RegistryProgressBar progress={progress} compact />
        </div>
      )}

      {confirmRemove && (
        <RemoveRegistryDialog registry={r} onClose={() => setConfirmRemove(false)} />
      )}
    </li>
  );
}
