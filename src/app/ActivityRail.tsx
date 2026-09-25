import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge, BoxIcon, ClockIcon, CloudIcon, GearIcon, NetworkIcon, StackIcon, Tooltip, UserIcon } from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { shortcutForPath } from "@/app/shortcuts";
import { PullRequestIcon } from "@/app/icons";

/** "Marketplace · Ctrl+M". El tooltip es donde alguien se entera del atajo. */
function withShortcut(label: string, path: string | null): string {
  const hint = path ? shortcutForPath(path) : null;
  return hint ? `${label} · ${hint}` : label;
}

function RailButton({
  label, path, active, badge, onClick, children,
}: {
  label: string;
  path: string | null;
  active: boolean;
  badge?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={withShortcut(label, path)} placement="right" delay={400}>
    <button
      onClick={onClick}
      className={`cc-t relative flex items-center justify-center w-9 h-9 rounded-[9px] shrink-0
        ${active
          ? "text-gray-900 dark:text-white bg-gray-200/70 dark:bg-white/7"
          : "text-gray-400 dark:text-white/40 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
    >
      {/* El acento va contra el borde exterior de la ventana, como en cualquier riel. */}
      {active && (
        <span className="absolute -left-1.5 top-2 w-0.5 h-5 rounded-sm
          bg-linear-to-b from-blue-500 to-violet-500
          dark:from-blue-400 dark:to-violet-400" />
      )}
      {children}
      {badge != null && badge > 0 && (
        <Badge
          variant="accent"
          size="sm"
          pill
          className="absolute -top-0.5 -right-0.5 pointer-events-none"
        >
          {badge}
        </Badge>
      )}
    </button>
    </Tooltip>
  );
}

/**
 * El riel de la izquierda.
 *
 * Es lo primero que se ve, y por eso lleva lo de los AGENTES: un IDE abre con el árbol de
 * archivos porque lo primero es el código; acá lo primero es qué está corriendo. El
 * explorador queda del otro lado.
 */
export function ActivityRail({ agentCount }: { agentCount: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const collapsed = useUiStore((s) => s.workspacesCollapsed);
  const toggleWorkspaces = useUiStore((s) => s.toggleWorkspaces);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setAccountsOpen = useUiStore((s) => s.setAccountsOpen);
  const accountsOpen = useUiStore((s) => s.accountsOpen);

  // `startsWith` y no `===`: si no, /marketplace/registries no ilumina Marketplace.
  const on = (path: string) => pathname.startsWith(path) && path !== "/";

  return (
    <nav className="flex flex-col items-center gap-0.5 w-12 shrink-0 py-1.5
      bg-gray-100 dark:bg-[#080b0f]
      border-r border-gray-200 dark:border-white/7">

      <RailButton
        label={t("rail.workspaces")}
        path={null}
        active={!collapsed}
        badge={agentCount}
        onClick={toggleWorkspaces}
      >
        <StackIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton label={t("sidebar.sessions")} path="/sessions" active={on("/sessions")} onClick={() => navigate("/sessions")}>
        <ClockIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton label={t("sidebar.fleet")} path="/fleet" active={on("/fleet")} onClick={() => navigate("/fleet")}>
        <NetworkIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton label={t("sidebar.forge")} path="/forge" active={on("/forge")} onClick={() => navigate("/forge")}>
        <PullRequestIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton label={t("sidebar.skills")} path="/skills" active={on("/skills")} onClick={() => navigate("/skills")}>
        <BoxIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton label={t("sidebar.marketplace")} path="/marketplace" active={on("/marketplace")} onClick={() => navigate("/marketplace")}>
        <CloudIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <div className="flex-1" />

      {/* Cuentas es su propia pantalla, no un atajo a una sección de Configuración: es lo
          que va a ir creciendo a medida que se sumen servicios que pidan iniciar sesión. */}
      <RailButton
        label={t("settings.accounts")}
        path={null}
        active={accountsOpen}
        onClick={() => setAccountsOpen(true)}
      >
        <UserIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton label={t("sidebar.settings")} path="/settings" active={settingsOpen} onClick={() => setSettingsOpen(true)}>
        <GearIcon className="w-[18px] h-[18px]" />
      </RailButton>
    </nav>
  );
}
