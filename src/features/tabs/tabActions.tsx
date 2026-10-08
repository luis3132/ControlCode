import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { BoxIcon, Button, CloseIcon, CopyIcon, IconReset } from "neogestify-ui-components";

import { SplitDownIcon, SplitRightIcon } from "@/app/icons";
import { refreshSessionTitle } from "@/features/sessions/sessionTitle";
import type { PrelaunchStep } from "@/features/prelaunch/types";
import { attachSkillsToTab, tabSkillIds } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { SkillPalette, type SkillScopeTarget } from "@/features/skills/SkillPalette";
import { useSkillsStore } from "@/features/skills/store";
import { currentLayout, splitGroup } from "@/features/tabs/layout/layoutStore";
import { groupOf, isAgentKey, keyId, type SplitSide } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type AgentInfo, type Tab } from "@/features/tabs/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { NewAgentDialog } from "@/features/tabs/wizard/NewAgentDialog";
import type { WizardResult } from "@/features/tabs/wizard/useAgentWizard";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import i18n from "@/i18n";
import { AppDialog } from "@/shared/ui/AppDialog";
import { ContextMenu } from "@/shared/ui/ContextMenu";

/**
 * Lo que se puede hacer con una tab desde cualquier tira —la de la barra de título o la de
 * un grupo— y los diálogos que eso abre. Viven en un solo lugar para que cada tira no
 * monte los suyos: con tres grupos habría tres asistentes de agente nuevo.
 */

interface TabActionsState {
  menu: { key: string; x: number; y: number } | null;
  /** Una tab con cambios sin guardar que se pidió cerrar: se confirma antes. */
  closingDirty: string | null;
  skillTarget: SkillScopeTarget | null;
  wizardOpen: boolean;
  /** El asistente abierto para algo concreto y no desde el "+": duplicar una tab (arranca
   *  con sus skills y comandos previos) o trabajar un issue (el agente nuevo recibe
   *  `prompt` apenas arranca). */
  wizardFor: WizardFor | null;
  /** "Agregar carpeta": el asistente empieza por elegir la carpeta. */
  addFolderOpen: boolean;
}

const useTabActions = create<TabActionsState>(() => ({
  menu: null,
  closingDirty: null,
  skillTarget: null,
  wizardOpen: false,
  wizardFor: null,
  addFolderOpen: false,
}));

interface WizardFor {
  cwd: string;
  title: string;
  skillIds?: string[];
  prelaunch?: PrelaunchStep[];
  prompt?: string;
}

/** Abre el asistente de agente nuevo en `cwd`; lo que se elija arranca con `prompt`. */
export const openNewAgentWith = (wizardFor: WizardFor) => useTabActions.setState({ wizardFor });

export const openTabMenu = (key: string, x: number, y: number) => useTabActions.setState({ menu: { key, x, y } });
export const openNewAgentWizard = () => useTabActions.setState({ wizardOpen: true });
/** Sumar una carpeta al workspace: el asistente en un modal, empezando por elegirla. */
export const openAddFolderWizard = () => useTabActions.setState({ addFolderOpen: true });

/**
 * Abre lo que se eligió en el asistente: la tab, con sus skills montadas antes de que el
 * agente arranque (varias TUIs solo escanean su carpeta al boot; Terminal.tsx espera esta
 * promesa antes de invocar pty_create), y el `prompt` si lo había. El modal del "+" e Inicio
 * terminan los dos acá.
 */
export function launchAgent({ cwd, agent, skillIds, accountId, prelaunch }: WizardResult, prompt?: string): string {
  const { workspaceId, addTab } = useTabsStore.getState();
  const tabId = addTab({ cwd, agent, accountId, prelaunch });
  registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, workspaceId, skillIds));
  if (prompt) sendWhenReady(tabId, prompt);
  return tabId;
}

export async function requestCloseItem(key: string): Promise<void> {
  if (isAgentKey(key)) {
    const { tabs, updateTab, closeTab } = useTabsStore.getState();
    const tab = tabs.find((x) => x.id === keyId(key));
    // El título de una sesión se resuelve leyendo su transcript, y cerrar la tab es la
    // última chance de hacerlo: después el proceso ya no está para preguntarle.
    if (tab) {
      const title = await refreshSessionTitle(tab);
      if (title !== tab.title) updateTab(tab.id, { title });
    }
    closeTab(keyId(key));
    return;
  }
  const { views, closeView } = useViewTabsStore.getState();
  const view = views.find((v) => v.id === keyId(key));
  if (view?.kind === "file" && view.dirty) useTabActions.setState({ closingDirty: view.id });
  else closeView(keyId(key));
}

/**
 * Otra tab como `tab`: misma carpeta, misma TUI, misma cuenta, mismos comandos previos y
 * las mismas skills. La conversación no: arranca una nueva — para seguir la misma está
 * Sesiones, y dos procesos escribiendo el mismo transcript lo corromperían.
 */
async function duplicateTab(tab: Tab): Promise<void> {
  const { workspaceId, addTab } = useTabsStore.getState();
  const skillIds = await tabSkillIds(tab.id).catch(() => []);
  const agent: AgentInfo = { id: tab.agentId, label: tab.agentLabel, command: tab.command, available: true };
  const tabId = addTab({ cwd: tab.cwd, agent, accountId: tab.accountId, prelaunch: tab.prelaunch });
  registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, workspaceId, skillIds));
}

async function duplicateWithOtherAgent(tab: Tab): Promise<void> {
  const [skillIds] = await Promise.all([
    tabSkillIds(tab.id).catch(() => []),
    // El asistente filtra por las skills que soporta cada TUI: necesita el catálogo.
    useSkillsStore.getState().loadSkills().catch(() => {}),
  ]);
  useTabActions.setState({
    wizardFor: { cwd: tab.cwd, skillIds, prelaunch: tab.prelaunch, title: i18n.t("tabs.duplicateOtherTitle") },
  });
}

/** Divide el grupo de `key` llevándola al grupo nuevo. */
export function splitWithItem(key: string, side: SplitSide): void {
  const layout = currentLayout();
  const group = layout ? groupOf(layout, key) : undefined;
  if (group) splitGroup(group.id, side, key);
}

export function TabDialogs() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { menu, closingDirty, skillTarget, wizardOpen, wizardFor, addFolderOpen } = useTabActions();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTab = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId));
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const views = useViewTabsStore((s) => s.views);
  const restartAgent = useTabsStore((s) => s.restartAgent);
  const close = (patch: Partial<TabActionsState>) => useTabActions.setState(patch);

  const menuItems = () => {
    if (!menu) return [];
    const split = [
      { key: "splitRight", label: t("tabs.split.right"), icon: <SplitRightIcon className="w-4 h-4" />, onSelect: () => splitWithItem(menu.key, "right") },
      { key: "splitDown", label: t("tabs.split.down"), icon: <SplitDownIcon className="w-4 h-4" />, onSelect: () => splitWithItem(menu.key, "down") },
    ];
    if (!isAgentKey(menu.key)) {
      return [...split, { key: "close", label: t("btn.close"), icon: <CloseIcon className="w-4 h-4" />, danger: true, onSelect: () => requestCloseItem(menu.key) }];
    }
    const tab = tabs.find((x) => x.id === keyId(menu.key));
    if (!tab) return [];
    return [
      {
        key: "skills",
        label: t("skills.scope.tabAction"),
        icon: <BoxIcon className="w-4 h-4" />,
        onSelect: () => close({ skillTarget: { scope: "tab", workspaceId, tabId: tab.id, agentId: tab.agentId, label: tab.title } }),
      },
      // Reiniciar es lo único que cambia los MCP con los que corre un agente: se le
      // enchufan al arrancar y un proceso vivo no los puede tomar. Con sesión conocida
      // retoma la conversación; sin ella empieza una nueva, y el texto lo dice.
      {
        key: "restart",
        label: tab.sessionId ? t("tabs.restart") : t("tabs.restartFresh"),
        icon: <IconReset className="w-4 h-4" />,
        onSelect: () => restartAgent(tab.id),
      },
      // La terminal pelada no tiene skills ni TUI que cambiar: duplicarla es abrir otra.
      {
        key: "duplicate",
        label: tab.agentId === SHELL_AGENT_ID ? t("tabs.duplicateShell") : t("tabs.duplicate"),
        icon: <CopyIcon className="w-4 h-4" />,
        separator: true,
        onSelect: () => { duplicateTab(tab).catch(console.error); navigate("/workspace"); },
      },
      ...(tab.agentId === SHELL_AGENT_ID ? [] : [{
        key: "duplicateOther",
        label: t("tabs.duplicateOther"),
        icon: <CopyIcon className="w-4 h-4" />,
        onSelect: () => { duplicateWithOtherAgent(tab).catch(console.error); },
      }]),
      { ...split[0], separator: true },
      split[1],
      { key: "close", label: t("tabs.close"), icon: <CloseIcon className="w-4 h-4" />, danger: true, separator: true, onSelect: () => requestCloseItem(menu.key) },
    ];
  };

  return (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => close({ menu: null })} items={menuItems()} />}

      {closingDirty && (
        <AppDialog
          title={t("editor.closeDirty.title")}
          size="sm"
          closeOnEsc
          onClose={() => close({ closingDirty: null })}
          footer={
            <>
              <Button variant="outline" onClick={() => close({ closingDirty: null })}>{t("btn.cancel")}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  useViewTabsStore.getState().closeView(closingDirty);
                  close({ closingDirty: null });
                }}
              >
                {t("editor.closeDirty.confirm")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("editor.closeDirty.body", { name: views.find((v) => v.id === closingDirty)?.title ?? "" })}
          </p>
        </AppDialog>
      )}

      {skillTarget && <SkillPalette target={skillTarget} onClose={() => close({ skillTarget: null })} />}

      <NewAgentDialog
        isOpen={addFolderOpen || (wizardOpen && activeTab !== undefined) || wizardFor !== null}
        // "Agregar carpeta" no trae carpeta: el asistente empieza por elegirla.
        cwd={addFolderOpen ? undefined : wizardFor?.cwd ?? activeTab?.cwd ?? ""}
        title={addFolderOpen ? t("folders.add") : wizardFor?.title}
        initialSkillIds={wizardFor?.skillIds}
        initialPrelaunch={wizardFor?.prelaunch}
        onClose={() => close({ wizardOpen: false, wizardFor: null, addFolderOpen: false })}
        onConfirm={(result) => {
          launchAgent(result, wizardFor?.prompt);
          navigate("/workspace");
        }}
      />
    </>
  );
}
