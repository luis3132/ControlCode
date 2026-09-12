import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, ShieldIcon, TrashIcon } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import * as ipc from "./ipc";
import type { PermissionRule } from "./types";

/**
 * Lo que los agentes de esta carpeta pueden hacer sin preguntar.
 *
 * Existe sobre todo para poder DESHACER: un "recordar" apretado de más, sin un lugar donde
 * verlo y borrarlo, sería una autorización permanente que no se puede revocar desde la app.
 * Agregar a mano es lo secundario — para lo que "recordar" no cubre a propósito, como
 * `Bash(git status*)` con comodín.
 */
export function RulesDialog({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [pattern, setPattern] = useState("");
  const [allow, setAllow] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = () => ipc.listRules(cwd).then(setRules).catch((e) => setError(String(e)));

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const add = async () => {
    if (!pattern.trim()) return;
    setBusy(true);
    setError("");
    try {
      await ipc.addRule(cwd, pattern.trim(), allow);
      setPattern("");
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      await ipc.deleteRule(id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <AppDialog
      title={t("fleet.rules.title")}
      icon={<ShieldIcon className="w-4 h-4 text-gray-500 dark:text-white/50" />}
      size="lg"
      closeOnEsc
      onClose={onClose}
    >
      <div className="flex flex-col gap-3.5">
        <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/45">
          {t("fleet.rules.desc")}{" "}
          <span className="font-mono text-gray-700 dark:text-white/65">{cwd}</span>
        </p>

        {rules.length === 0 ? (
          <p className="py-4 text-center text-[11.5px] italic text-gray-400 dark:text-white/30">
            {t("fleet.rules.empty")}
          </p>
        ) : (
          // El orden importa y se dice: gana la primera que coincide.
          <ol className="flex flex-col rounded-lg overflow-hidden
            border border-gray-200 dark:border-white/10
            divide-y divide-gray-200 dark:divide-white/8">
            {rules.map((rule, i) => (
              <li key={rule.id} className="flex items-center gap-2.5 px-2.5 h-9">
                <span className="shrink-0 w-4 text-right tabular-nums text-[10px]
                  text-gray-400 dark:text-white/25">
                  {i + 1}
                </span>
                <span className={`shrink-0 px-1.5 py-px rounded-full text-[9.5px] font-bold
                  uppercase tracking-wider
                  ${rule.allow
                    ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/12"
                    : "text-red-600 dark:text-red-400 bg-red-500/12"}`}>
                  {rule.allow ? t("fleet.rules.allow") : t("fleet.rules.deny")}
                </span>
                <span title={rule.pattern} className="flex-1 min-w-0 truncate font-mono text-[11px]
                  text-gray-800 dark:text-gray-200">
                  {rule.pattern}
                </span>
                <button
                  onClick={() => remove(rule.id)}
                  title={t("fleet.rules.delete")}
                  aria-label={t("fleet.rules.delete")}
                  className="cc-t flex items-center justify-center w-6 h-6 rounded shrink-0
                    text-gray-400 dark:text-white/30
                    hover:text-red-600 dark:hover:text-red-400
                    hover:bg-red-500/10"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ol>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
              placeholder="Bash(git status*)"
              aria-label={t("fleet.rules.pattern")}
              className="flex-1 min-w-0 rounded-lg px-2.5 h-8 outline-none font-mono text-[11.5px]
                bg-gray-100 dark:bg-white/5
                border border-gray-200 dark:border-white/10
                focus:border-blue-400 dark:focus:border-blue-500
                text-gray-800 dark:text-gray-200"
            />
            <div className="flex shrink-0 rounded-lg overflow-hidden
              border border-gray-200 dark:border-white/10">
              {[true, false].map((value) => (
                <button
                  key={String(value)}
                  onClick={() => setAllow(value)}
                  className={`cc-t px-2.5 h-8 text-[11px]
                    ${allow === value
                      ? value
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "bg-red-500/15 text-red-600 dark:text-red-300"
                      : "text-gray-500 dark:text-white/45 hover:bg-gray-200 dark:hover:bg-white/8"}`}
                >
                  {value ? t("fleet.rules.allow") : t("fleet.rules.deny")}
                </button>
              ))}
            </div>
            <Button variant="primary" size="sm" disabled={busy || !pattern.trim()} onClick={add}>
              {t("fleet.rules.add")}
            </Button>
          </div>
          <span className="text-[10px] leading-relaxed text-gray-400 dark:text-white/30">
            {t("fleet.rules.syntax")}
          </span>
        </div>

        {error && <Alert variant="danger">{error}</Alert>}
      </div>
    </AppDialog>
  );
}
