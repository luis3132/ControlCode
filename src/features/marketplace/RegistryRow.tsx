import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";
import { EditIcon, TrashIcon, CloudIcon, FolderIcon, AnimateSpin, IconReset } from "neogestify-ui-components";
import { Switch } from "@/shared/ui/Switch";
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
  const { refreshingId, refreshRegistry, setRegistryEnabled, renameRegistry } = useMarketplaceStore();
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
    <li className="flex flex-col px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex items-center justify-center w-8 h-8 rounded-full shrink-0
          bg-gray-100 dark:bg-white/8 text-gray-500 dark:text-gray-400">
          <SourceIcon className="w-4 h-4" />
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
                className="bg-transparent border-b border-blue-400 outline-none text-sm font-medium
                  text-gray-900 dark:text-white min-w-0 max-w-[16rem]"
              />
            ) : (
              <>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{r.name}</span>
                <button
                  onClick={() => { setNameDraft(r.name); setEditing(true); }}
                  title={t("marketplace.registries.rename")}
                  className="opacity-0 group-hover/name:opacity-100 text-gray-400 hover:text-gray-700
                    dark:hover:text-white transition-opacity shrink-0"
                >
                  <EditIcon className="w-3 h-3" />
                </button>
              </>
            )}
            <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0
              bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400">
              {r.sourceType}
            </span>
          </div>

          {/* Un repo de skills.sh sin filtro no tiene ubicación que mostrar; sin esto la
              línea queda vacía y parece un dato que falta. */}
          <p className="text-xs text-gray-400 dark:text-gray-500 truncate font-mono">
            {r.location || t("marketplace.registries.wholeDirectory")}
          </p>

          {r.error ? (
            <p className="text-xs text-red-500 dark:text-red-400 truncate mt-0.5">{r.error}</p>
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
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
            <p className="text-xs text-amber-600 dark:text-amber-400/80 mt-0.5">
              {t("marketplace.registries.skillsShNotListable")}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={r.enabled}
            onChange={(enabled) => setRegistryEnabled(r.id, enabled)}
            title={r.enabled ? t("marketplace.registries.enabled") : t("marketplace.registries.disabled")}
          />
          <Button
            variant="icon"
            onClick={() => refreshRegistry(r.id)}
            disabled={refreshing}
            title={t("marketplace.registries.refresh")}
          >
            {refreshing ? <AnimateSpin className="w-4 h-4" /> : <IconReset className="w-4 h-4" />}
          </Button>
          <Button variant="icon" onClick={() => setConfirmRemove(true)} title={t("marketplace.registries.remove")}
            className="hover:text-red-500! dark:hover:text-red-400!">
            <TrashIcon className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Debajo de la fila (no al costado) para que la barra ocupe todo el ancho: un repo
          grande son decenas de requests y el porcentaje es lo que dice si vale la pena esperar. */}
      {refreshing && (
        <div className="mt-2 pl-11">
          <RegistryProgressBar progress={progress} compact />
        </div>
      )}

      {confirmRemove && (
        <RemoveRegistryDialog registry={r} onClose={() => setConfirmRemove(false)} />
      )}
    </li>
  );
}
