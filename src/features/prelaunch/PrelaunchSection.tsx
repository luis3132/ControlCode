import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, AddIcon, TrashIcon, EditIcon, InfoIcon } from "neogestify-ui-components";
import { usePrelaunchStore } from "@/features/prelaunch/store";
import type { PrelaunchPreset } from "@/features/prelaunch/types";

/** Alta y edición usan el mismo formulario; `initial` decide cuál de las dos es. */
function PresetForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: PrelaunchPreset;
  onSave: (draft: { id?: string; name: string; command: string }) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ id: initial?.id, name: name.trim(), command: command.trim() });
      if (!initial) {
        setName("");
        setCommand("");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const valid = name.trim() && command.trim();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("prelaunch.namePlaceholder")}
          className="sm:w-56"
        />
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) submit();
          }}
          placeholder={t("prelaunch.commandPlaceholder")}
          className="flex-1 font-mono text-xs"
        />
        <div className="flex gap-2">
          <Button variant="primary" size="sm" onClick={submit} disabled={!valid || saving}>
            {initial ? t("btn.save") : <AddIcon className="w-3.5 h-3.5" />}
          </Button>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("btn.cancel")}
            </Button>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

/**
 * Comandos que se ejecutan antes de lanzar un agente.
 *
 * Acá solo se guardan; elegir cuáles usar (y en qué orden) pasa al abrir cada tab, en
 * "Opciones avanzadas". La separación es a propósito: un `conda activate ml` se escribe una
 * vez y se reusa, mientras que la cadena concreta cambia según el proyecto.
 */
export function PrelaunchSection() {
  const { t } = useTranslation();
  const { presets, loaded, load, save, remove } = usePrelaunchStore();
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { if (!loaded) load().catch(console.error); }, [loaded, load]);

  return (
    <section className="bg-linear-to-br from-white to-gray-50
      dark:from-gray-800 dark:to-gray-900
      rounded-xl border border-gray-200 dark:border-gray-700
      shadow-sm hover:shadow-md transition-shadow duration-300 p-6">

      <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-1">
        {t("settings.prelaunch")}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t("settings.prelaunch.desc")}
      </p>

      {presets.length > 0 && (
        <div className="flex flex-col gap-2 mb-4">
          {presets.map((preset) =>
            editingId === preset.id ? (
              <div
                key={preset.id}
                className="px-4 py-3 rounded-xl border border-blue-300 dark:border-blue-500/40
                  bg-blue-50/40 dark:bg-blue-500/5"
              >
                <PresetForm
                  initial={preset}
                  onSave={async (draft) => {
                    await save(draft);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            ) : (
              <div
                key={preset.id}
                className="group flex items-center justify-between gap-3 px-4 py-3
                  rounded-xl border border-gray-200 dark:border-gray-700
                  bg-gray-50/60 dark:bg-white/[0.02]
                  hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                    {preset.name}
                  </span>
                  <code className="text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate">
                    {preset.command}
                  </code>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100
                  focus-within:opacity-100 transition-opacity shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditingId(preset.id)}
                    aria-label={t("btn.edit")}
                    className="w-7 h-7 grid place-items-center rounded-lg text-gray-400
                      hover:text-gray-700 dark:hover:text-gray-200
                      hover:bg-gray-200/60 dark:hover:bg-white/10"
                  >
                    <EditIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(preset.id).catch(console.error)}
                    aria-label={t("btn.delete")}
                    className="w-7 h-7 grid place-items-center rounded-lg text-gray-400
                      hover:text-red-500 hover:bg-red-500/10"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      <PresetForm onSave={async (draft) => { await save(draft); }} />

      <div className="flex items-start gap-2 mt-4 text-xs text-gray-500 dark:text-gray-400">
        <InfoIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <p>{t("settings.prelaunch.hint")}</p>
      </div>
    </section>
  );
}
