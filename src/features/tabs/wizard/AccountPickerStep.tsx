import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAccountsStore } from "@/features/accounts/store";

interface AccountPickerStepProps {
  /** TUI elegida. Sin ella no hay cuentas que ofrecer. */
  agentId: string;
  /** `undefined` = la cuenta del sistema. */
  value: string | undefined;
  onChange: (accountId: string | undefined) => void;
}

/**
 * Con qué cuenta arrancar la TUI.
 *
 * **No se muestra si no hay nada que elegir.** Con la cuenta del sistema sola, un selector
 * de una opción es una pregunta con una sola respuesta: ruido en el camino de abrir una
 * tab, que es lo que más se hace en la app. Aparece recién cuando existe una segunda
 * cuenta para esa TUI, que es cuando la pregunta empieza a tener sentido.
 *
 * La cuenta se elige al abrir la tab y no se puede cambiar después: la TUI lee su
 * configuración al arrancar, así que cambiarla en caliente no haría nada. Para otra cuenta,
 * otra tab.
 */
export function AccountPickerStep({ agentId, value, onChange }: AccountPickerStepProps) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const loaded = useAccountsStore((s) => s.loaded);
  const load = useAccountsStore((s) => s.load);
  useEffect(() => { if (!loaded) load().catch(console.error); }, [loaded, load]);

  const forAgent = useMemo(
    () => accounts.filter((a) => a.agentId === agentId),
    [accounts, agentId]
  );

  // Una cuenta elegida antes puede haber desaparecido (se borró desde Settings mientras el
  // wizard estaba abierto, o se cambió de agente) — se vuelve a la del sistema en vez de
  // dejar seleccionada una que ya no existe.
  useEffect(() => {
    if (value && !forAgent.some((a) => a.id === value)) onChange(undefined);
  }, [value, forAgent, onChange]);

  if (forAgent.length === 0) return null;

  const options = [
    { id: undefined, name: t("accounts.system"), hint: t("accounts.system.hint"), warn: false },
    ...forAgent.map((a) => ({
      id: a.id as string | undefined,
      name: a.name,
      // El mail es lo que de verdad identifica la cuenta; el nombre lo eligió el usuario.
      hint: a.label ?? (a.loggedIn ? t("accounts.ready") : t("accounts.needsLogin")),
      warn: !a.loggedIn,
    })),
  ];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-widest
        text-gray-400 dark:text-gray-500">
        {t("accounts.pick")}
      </span>

      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const isSelected = option.id === value;
          return (
            <button
              key={option.id ?? "system"}
              type="button"
              onClick={() => onChange(option.id)}
              className={`
                flex flex-col items-start gap-0.5 px-3 py-2 rounded-lg border text-left
                transition-all duration-200 min-w-32
                ${isSelected
                  ? "border-blue-500 bg-linear-to-br from-blue-50 to-violet-50 dark:from-blue-500/10 dark:to-violet-500/10 shadow-sm"
                  : "border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-white/[0.02] hover:border-gray-300 dark:hover:border-gray-600"}
              `}
            >
              <span className={`text-xs font-semibold truncate max-w-40
                ${isSelected
                  ? "text-blue-700 dark:text-blue-300"
                  : "text-gray-800 dark:text-gray-100"}`}>
                {option.name}
              </span>
              <span className={`text-[10px] truncate max-w-40
                ${option.warn
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-gray-400 dark:text-gray-500"}`}>
                {option.hint}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
