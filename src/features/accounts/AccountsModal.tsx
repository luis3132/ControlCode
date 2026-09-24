import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, UserIcon } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { AgentAccountsPane } from "@/features/accounts/AgentAccountsPane";
import { agentIcon } from "@/features/agents/agentIcons";
import { GitAccountsPane } from "@/features/forge/GitAccountsPane";
import { FORGE_KINDS, ForgeIcon, forgeLabel } from "@/features/forge/forgeMeta";
import { useForgeStore } from "@/features/forge/store";
import type { ForgeKind } from "@/features/forge/types";
import { ShellModal } from "@/shared/ui/ShellModal";

/** Qué servicio se está mirando: una TUI o un tipo de host git. */
export type AccountsSection = { kind: "agent"; id: string } | { kind: "git"; id: ForgeKind };

function NavHeading({ children }: { children: React.ReactNode }) {
  return (
    <span className="block px-1.5 pt-3 pb-1.5 text-[9.5px] font-extrabold uppercase
      tracking-[0.11em] text-gray-400 dark:text-white/30">
      {children}
    </span>
  );
}

function NavItem({ active, onClick, icon, label, count, title }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      // El número solo no dice qué es: al lado de un nombre puede leerse como una versión.
      title={title}
      className={`cc-t flex items-center gap-2 w-full h-8 px-2 rounded-lg text-left
        ${active
          ? "bg-blue-500/12 dark:bg-blue-400/13 text-gray-900 dark:text-white font-semibold"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
    >
      {icon}
      <span className="flex-1 min-w-0 truncate text-[11.5px]">{label}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/30">{count || ""}</span>
    </button>
  );
}

/**
 * Las cuentas de la app, en su propia pantalla.
 *
 * La columna de la izquierda son los SERVICIOS, en dos grupos:
 *
 * - **TUIs**: perfiles de las TUIs que soportan varias cuentas. Acá la app no guarda
 *   credenciales: cada cuenta es una carpeta y el login lo hace la TUI.
 * - **Git**: GitHub, GitLab, Gitea/Forgejo o cualquier host. Estas sí tienen un token, en
 *   el llavero del sistema, y son las que usan el control de versiones, el clonar del
 *   inicio y las tools de git del MCP.
 *
 * Agregar otro tipo de servicio es agregar un grupo a la lista y su panel, no rehacer la
 * pantalla.
 */
export function AccountsModal({ onClose, initial }: { onClose: () => void; initial?: AccountsSection }) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const capable = useAccountsStore((s) => s.capable);
  const loadAgents = useAccountsStore((s) => s.load);
  const gitAccounts = useForgeStore((s) => s.accounts);
  const loadGit = useForgeStore((s) => s.load);
  const [section, setSection] = useState<AccountsSection | null>(initial ?? null);
  const [error, setError] = useState("");

  useEffect(() => {
    loadAgents().catch((e) => setError(String(e)));
    loadGit().catch((e) => setError(String(e)));
  }, [loadAgents, loadGit]);

  /** TUIs que se muestran: las instaladas, más las que ya tengan cuentas creadas (para no
   *  esconder cuentas existentes si la TUI se desinstaló). */
  const shown = useMemo(
    () => capable.filter((c) => c.installed || accounts.some((a) => a.agentId === c.agentId)),
    [capable, accounts]
  );

  // Se elige algo solo: la pantalla arranca mostrando algo en vez de un hueco.
  useEffect(() => {
    if (section) return;
    setSection(shown.length > 0 ? { kind: "agent", id: shown[0].agentId } : { kind: "git", id: "github" });
  }, [section, shown]);

  const agent = section?.kind === "agent" ? shown.find((c) => c.agentId === section.id) : undefined;

  return (
    <ShellModal
      title={t("settings.accounts")}
      icon={<UserIcon className="w-[15px] h-[15px] shrink-0 text-blue-500 dark:text-blue-400" />}
      width="max-w-3xl"
      onClose={onClose}
    >
      {/* ══ los servicios ═════════════════════════════════════════════════ */}
      <nav className="flex flex-col w-48 shrink-0 min-h-0
        border-r border-gray-200 dark:border-white/8 bg-gray-100/50 dark:bg-black/20">
        <div className="flex-1 min-h-0 cc-scroll px-1.5 pb-2">
          <NavHeading>{t("accounts.group.tuis")}</NavHeading>
          {shown.length === 0 ? (
            <p className="px-2 pb-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("settings.accounts.noneInstalled")}</p>
          ) : shown.map((c) => {
            const Icon = agentIcon(c.agentId, c.label);
            const n = accounts.filter((a) => a.agentId === c.agentId).length;
            return (
              <NavItem
                key={c.agentId}
                active={section?.kind === "agent" && section.id === c.agentId}
                onClick={() => setSection({ kind: "agent", id: c.agentId })}
                icon={<Icon className="w-3.5 h-3.5 shrink-0" />}
                label={c.label}
                count={n}
                // `count` SÍ es lo que se quiere acá: la clave tiene formas _one/_other.
                title={t("settings.accounts.count", { count: n })}
              />
            );
          })}

          <NavHeading>{t("accounts.group.git")}</NavHeading>
          {FORGE_KINDS.map((kind) => {
            const n = gitAccounts.filter((a) => a.kind === kind).length;
            return (
              <NavItem
                key={kind}
                active={section?.kind === "git" && section.id === kind}
                onClick={() => setSection({ kind: "git", id: kind })}
                icon={<ForgeIcon kind={kind} className="w-3.5 h-3.5 shrink-0" />}
                label={forgeLabel(kind, t)}
                count={n}
                title={t("settings.accounts.count", { count: n })}
              />
            );
          })}
        </div>
        {/* Las TUIs instaladas que NO aparecen tienen un motivo, y decirlo evita que se
            lea como un olvido. */}
        <p className="shrink-0 px-3 py-2 text-[10px] leading-relaxed
          border-t border-gray-200 dark:border-white/8 text-gray-400 dark:text-white/30">
          {t("settings.accounts.unsupportedNote")}
        </p>
      </nav>

      {/* ══ sus cuentas ═══════════════════════════════════════════════════ */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {section?.kind === "git" ? (
          <GitAccountsPane kind={section.id} />
        ) : agent ? (
          <AgentAccountsPane agent={agent} />
        ) : (
          <EmptyState className="m-auto" icon={<UserIcon className="w-8 h-8" />} title={t("settings.accounts.noneInstalled")} />
        )}
        {error && <p className="shrink-0 px-4 pb-2 text-[11px] text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </ShellModal>
  );
}
