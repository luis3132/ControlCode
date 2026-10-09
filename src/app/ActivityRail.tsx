import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, AddIcon, Badge, BoxIcon, ClockIcon, CloudIcon, FolderIcon, GearIcon, NetworkIcon, Tooltip, UserIcon } from "neogestify-ui-components";

import { WorkspaceChip } from "@/app/WorkspaceChip";
import { useUiStore } from "@/app/uiStore";
import { shortcutForPath } from "@/app/shortcuts";
import { ProcessIcon, PullRequestIcon } from "@/app/icons";
import { useRunsStore } from "@/features/runs/store";
import { useRunningHere } from "@/features/processes/ProcessIndicator";
import { openAddFolderWizard } from "@/features/tabs/tabActions";

/** "Marketplace · Ctrl+M". El tooltip es donde alguien se entera del atajo. */
function withShortcut(label: string, path: string | null): string {
  const hint = path ? shortcutForPath(path) : null;
  return hint ? `${label} · ${hint}` : label;
}

function RailButton({
  label, path, active, badge, badgeVariant = "accent", onClick, children,
}: {
  label: string;
  path: string | null;
  active: boolean;
  badge?: number;
  /** `warning` = alguien te está esperando, no un simple conteo. */
  badgeVariant?: "accent" | "warning";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={withShortcut(label, path)} placement="right" delay={400}>
    <Button variant="icon"
      onClick={onClick}
      className={`cc-t relative flex items-center justify-center w-9 h-9 rounded-[9px] shrink-0
        ${active
          ? "text-gray-900 dark:text-white bg-gray-200/70 dark:bg-white/7"
          : "text-gray-400 dark:text-white/40 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200/60 dark:hover:bg-white/6"} p-0`}
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
          variant={badgeVariant}
          size="sm"
          pill
          className={`absolute -top-0.5 -right-0.5 pointer-events-none
            ${badgeVariant === "warning" ? "animate-pulse" : ""}`}
        >
          {badge}
        </Badge>
      )}
    </Button>
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
  // Permisos que un agente de la flota está esperando: se ven desde cualquier pantalla. Los
  // de las tabs en modo HTML no: el globo lleva a la flota, y esos se contestan en su chat.
  const pendingApprovals = useRunsStore((s) => s.approvals.filter((a) => a.taskId !== null).length);
  const runningProcs = useRunningHere();

  // `startsWith` y no `===`: si no, /marketplace/registries no ilumina Marketplace.
  const on = (path: string) => pathname.startsWith(path) && path !== "/";

  return (
    <nav className="flex flex-col items-center gap-0.5 w-12 shrink-0 py-1.5
      bg-gray-100 dark:bg-[#080b0f]
      border-r border-gray-200 dark:border-white/7">

      {/* Plegado, el selector de workspace y el "+" de Carpetas quedan escondidos con el
          panel: bajan acá, arriba de todo. */}
      {collapsed && (
        <>
          <WorkspaceChip compact />
          <RailButton
            label={t("folders.add")}
            path={null}
            active={false}
            onClick={openAddFolderWizard}
          >
            <AddIcon className="w-[18px] h-[18px]" />
          </RailButton>
          <span className="w-5 h-px my-1 shrink-0 bg-gray-300 dark:bg-white/10" />
        </>
      )}

      <RailButton
        label={t("rail.workspaces")}
        path={null}
        active={!collapsed}
        badge={agentCount}
        onClick={toggleWorkspaces}
      >
        <FolderIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton label={t("sidebar.sessions")} path="/sessions" active={on("/sessions")} onClick={() => navigate("/sessions")}>
        <ClockIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton
        label={pendingApprovals > 0 ? t("rail.fleetWaiting", { count: pendingApprovals }) : t("sidebar.fleet")}
        path="/fleet"
        active={on("/fleet")}
        badge={pendingApprovals}
        badgeVariant="warning"
        onClick={() => navigate("/fleet")}
      >
        <NetworkIcon className="w-[18px] h-[18px]" />
      </RailButton>

      <RailButton
        label={runningProcs > 0 ? t("rail.processesRunning", { count: runningProcs }) : t("sidebar.processes")}
        path="/processes"
        active={on("/processes")}
        badge={runningProcs}
        onClick={() => navigate("/processes")}
      >
        <ProcessIcon className="w-[18px] h-[18px]" />
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
