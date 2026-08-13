import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Select } from "neogestify-ui-components";
import { AddIcon, TrashIcon, ChevronDownIcon } from "neogestify-ui-components";
import { CustomAgentDraft, emptyCustomAgent } from "@/features/agents/store";

interface CustomAgentFormProps {
  /** Draft inicial; `emptyCustomAgent()` para el alta. */
  initial?: CustomAgentDraft;
  onSubmit: (draft: CustomAgentDraft) => Promise<void>;
  onCancel?: () => void;
}

/** Campo con label chico + hint debajo, el patrón que se repite en todo el formulario. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">{label}</span>
      {children}
      {hint && <p className="text-[11px] text-gray-400 dark:text-white/40">{hint}</p>}
    </div>
  );
}

export function CustomAgentForm({ initial, onSubmit, onCancel }: CustomAgentFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CustomAgentDraft>(initial ?? emptyCustomAgent());
  // La integración avanzada arranca plegada: una TUI con solo nombre + comando ya
  // funciona, y abrir el formulario entero de entrada haría parecer obligatorio lo que no lo es.
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(initial?.resumeArgs || initial?.skillsDir || initial?.sessionsDir ||
      Object.keys(initial?.env ?? {}).length > 0)
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = (p: Partial<CustomAgentDraft>) => setDraft((d) => ({ ...d, ...p }));

  const envRows = Object.entries(draft.env ?? {});

  const setEnvKey = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of envRows) next[k === oldKey ? newKey : k] = v;
    delete next[""];
    patch({ env: next });
  };

  const handleSubmit = async () => {
    if (!draft.label.trim() || !draft.command.trim()) {
      setError(t("settings.tuis.error"));
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        ...draft,
        label: draft.label.trim(),
        command: draft.command.trim(),
      });
      setError("");
      if (!initial?.id) setDraft(emptyCustomAgent());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg border border-dashed
      border-gray-300 dark:border-gray-600
      bg-gray-50/50 dark:bg-gray-900/30">

      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        {initial?.id ? t("settings.tuis.editSection") : t("settings.tuis.addSection")}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t("settings.tuis.name")}>
          <Input
            value={draft.label}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder={t("settings.tuis.namePlaceholder")}
            variant="outline"
          />
        </Field>
        <Field label={t("settings.tuis.command")} hint={t("settings.tuis.commandHint")}>
          <Input
            value={draft.command}
            onChange={(e) => patch({ command: e.target.value })}
            placeholder={t("settings.tuis.commandPlaceholder")}
            variant="outline"
          />
        </Field>
      </div>

      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        className="flex items-center gap-1.5 w-fit text-xs font-medium
          text-gray-500 dark:text-gray-400
          hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
      >
        <ChevronDownIcon
          className={`w-3.5 h-3.5 transition-transform duration-200 ${advancedOpen ? "" : "-rotate-90"}`}
        />
        {t("settings.tuis.advanced")}
      </button>

      {advancedOpen && (
        <div className="flex flex-col gap-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <p className="text-[11px] text-gray-400 dark:text-white/40">
            {t("settings.tuis.advancedDesc")}
          </p>

          <Field label={t("settings.tuis.resumeArgs")} hint={t("settings.tuis.resumeArgsHint")}>
            <Input
              value={draft.resumeArgs ?? ""}
              onChange={(e) => patch({ resumeArgs: e.target.value })}
              placeholder="--resume {session}"
              variant="outline"
            />
          </Field>

          <Field label={t("settings.tuis.skillsDir")} hint={t("settings.tuis.skillsDirHint")}>
            <Input
              value={draft.skillsDir ?? ""}
              onChange={(e) => patch({ skillsDir: e.target.value })}
              placeholder=".agents/skills"
              variant="outline"
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label={t("settings.tuis.sessionsDir")} hint={t("settings.tuis.sessionsDirHint")}>
              <Input
                value={draft.sessionsDir ?? ""}
                onChange={(e) => patch({ sessionsDir: e.target.value })}
                placeholder="~/.mitui/sessions"
                variant="outline"
              />
            </Field>
            <Field label={t("settings.tuis.sessionIdFrom")} hint={t("settings.tuis.sessionIdFromHint")}>
              {/* `filename` no necesita más datos; `field:` sí, así que el select elige la
                  estrategia y el input de al lado aparece solo para la que la necesita. */}
              <div className="flex flex-col gap-1">
                <Select
                  value={draft.sessionIdFrom.startsWith("field:") ? "field" : "filename"}
                  onChange={(e) =>
                    patch({ sessionIdFrom: e.target.value === "field" ? "field:session_id" : "filename" })
                  }
                  options={[
                    { value: "filename", label: t("settings.tuis.sessionIdFrom.filename") },
                    { value: "field", label: t("settings.tuis.sessionIdFrom.field") },
                  ]}
                  variant="outline"
                />
                {draft.sessionIdFrom.startsWith("field:") && (
                  <Input
                    value={draft.sessionIdFrom.slice("field:".length)}
                    onChange={(e) => patch({ sessionIdFrom: `field:${e.target.value}` })}
                    placeholder="session_id"
                    variant="outline"
                  />
                )}
              </div>
            </Field>
          </div>

          <Field label={t("settings.tuis.env")} hint={t("settings.tuis.envHint")}>
            <div className="flex flex-col gap-2">
              {envRows.map(([key, value]) => (
                <div key={key} className="flex items-center gap-2">
                  <Input
                    value={key}
                    onChange={(e) => setEnvKey(key, e.target.value)}
                    placeholder="MI_VARIABLE"
                    variant="outline"
                  />
                  <Input
                    value={value}
                    onChange={(e) => patch({ env: { ...draft.env, [key]: e.target.value } })}
                    placeholder="valor"
                    variant="outline"
                  />
                  <Button
                    variant="danger"
                    className="shrink-0"
                    onClick={() => {
                      const next = { ...draft.env };
                      delete next[key];
                      patch({ env: next });
                    }}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                className="!text-xs w-fit"
                onClick={() => patch({ env: { ...draft.env, "": "" } })}
                disabled={"" in (draft.env ?? {})}
              >
                {t("settings.tuis.envAdd")}
              </Button>
            </div>
          </Field>
        </div>
      )}

      {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={handleSubmit}
          className="flex items-center gap-1.5 !text-sm w-fit">
          <AddIcon className="w-4 h-4" />
          {initial?.id ? t("btn.save") : t("btn.add")}
        </Button>
        {onCancel && (
          <Button variant="outline" disabled={busy} onClick={onCancel} className="!text-sm">
            {t("btn.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}
