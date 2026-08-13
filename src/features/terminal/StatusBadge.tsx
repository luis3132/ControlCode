import { useTranslation } from "react-i18next";

export type TerminalStatus = "connecting" | "running" | "exited";

const DOT: Record<TerminalStatus, string> = {
  running: "#34d399",
  connecting: "#fbbf24",
  exited: "#f87171",
};

/**
 * Indicador de estado del proceso. Flota SOBRE la terminal, así que sigue la paleta de la
 * terminal y no la de la app: en modo claro un recuadro negro acá se leería como un
 * artefacto pegado encima.
 */
export function StatusBadge({ status, command, isDark }: {
  status: TerminalStatus;
  command: string;
  isDark: boolean;
}) {
  const { t } = useTranslation();
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
        {status === "running"
          ? command
          : t(`terminal.status.${status}` as "terminal.status.connecting" | "terminal.status.exited")}
      </span>
    </div>
  );
}
