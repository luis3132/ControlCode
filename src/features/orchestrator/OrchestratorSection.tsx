import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "neogestify-ui-components";
import { getSetting, setSetting } from "@/shared/ipc/settings";

/** Misma clave que lee el backend (`orchestrator::WATCH_LIMIT_KEY`). */
const WATCH_LIMIT_KEY = "orchestrator_watch_limit";
const DEFAULT_WATCH_LIMIT = 3;

/**
 * Ajustes del modo orquestador (Fase 9).
 *
 * El único parámetro real es cuántas tabs puede observar a la vez un agente externo. Es un
 * tope de consumo, no de funcionalidad: cada tab observada le manda eventos, y más allá de
 * un puñado esos eventos solos ya llenan el contexto del modelo. Por eso el default es 3 y
 * subirlo se avisa.
 */
export function OrchestratorSection() {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(DEFAULT_WATCH_LIMIT);

  useEffect(() => {
    let stale = false;
    getSetting(WATCH_LIMIT_KEY)
      .then((value) => {
        const parsed = Number(value);
        if (!stale && Number.isInteger(parsed) && parsed > 0) setLimit(parsed);
      })
      .catch(console.error);
    return () => { stale = true; };
  }, []);

  const handleChange = async (value: string) => {
    setLimit(Number(value));
    await setSetting(WATCH_LIMIT_KEY, value).catch(console.error);
  };

  return (
    <section className="bg-linear-to-br from-white to-gray-50
      dark:from-gray-800 dark:to-gray-900
      rounded-xl border border-gray-200 dark:border-gray-700
      shadow-sm hover:shadow-md transition-shadow duration-300 p-6">

      <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
        {t("settings.orchestrator")}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        {t("settings.orchestrator.desc")}
      </p>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t("settings.orchestrator.watchLimit")}
          </span>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {t("settings.orchestrator.watchLimitHint")}
          </p>
        </div>
        <Select
          value={String(limit)}
          onChange={(e) => handleChange(e.target.value)}
          variant="outline"
          size="sm"
          options={[1, 2, 3, 4, 5, 8, 10].map((n) => ({
            value: String(n),
            label: n === DEFAULT_WATCH_LIMIT ? `${n} ${t("settings.orchestrator.default")}` : String(n),
          }))}
        />
      </div>

      {limit > 5 && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          {t("settings.orchestrator.watchLimitWarning")}
        </p>
      )}
    </section>
  );
}
