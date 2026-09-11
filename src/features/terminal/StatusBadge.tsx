import { useTranslation } from "react-i18next";

export type TerminalStatus = "connecting" | "running" | "exited";

const DOT: Record<"connecting" | "exited", string> = {
  connecting: "#fbbf24",
  exited: "#f87171",
};

/**
 * Indicador de estado del proceso. Flota SOBRE la terminal, así que sigue la paleta de la
 * terminal y no la de la app: en modo claro un recuadro negro acá se leería como un
 * artefacto pegado encima.
 *
 * **Mientras corre no muestra nada.** Antes mostraba el comando con el que se lanzó la
 * tab —`claude --resume 9f3c…`— que es información nuestra, no del usuario: el flag y el
 * uuid son cómo la app reengancha la sesión, y ahí arriba lo único que hacían era tapar
 * la esquina de la TUI con una cadena que nadie puede accionar.
 *
 * Que el proceso está vivo ya lo dicen la terminal, que está pintando, y el punto de la
 * tab. El recuadro queda entonces para lo que la terminal NO puede contar sola: que
 * todavía está arrancando (pantalla en negro) o que el proceso se murió (pantalla
 * congelada). Fuera de esos dos momentos, el espacio es de la TUI.
 */
export function StatusBadge({ status, isDark }: {
  status: TerminalStatus;
  isDark: boolean;
}) {
  const { t } = useTranslation();
  if (status === "running") return null;

  return (
    <div
      className={`absolute top-2 right-2 z-10 flex items-center gap-2 px-2 py-1 rounded-lg
        text-xs font-mono border
        ${isDark ? "bg-slate-900 border-slate-700" : "bg-white/90 border-gray-200 shadow-sm"}`}
    >
      <span
        className="w-1.5 h-1.5"
        style={{ borderRadius: "50%", background: DOT[status] }}
      />
      <span className={isDark ? "text-white/80" : "text-gray-600"}>
        {t(`terminal.status.${status}` as "terminal.status.connecting" | "terminal.status.exited")}
      </span>
    </div>
  );
}
