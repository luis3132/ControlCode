import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { PrelaunchStep } from "@/features/prelaunch/types";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { flushPendingSave } from "@/features/tabs/persistence";
import { useTabsStore } from "@/features/tabs/store";
import { broadcastEvent, focusWindow } from "@/shared/ipc/window";

import * as ipc from "./ipc";
import { useSessionsStore } from "./store";
import type { SessionHistoryEntry, SessionSkillStatus } from "./types";

/** Sesión que el usuario quiso reabrir pero quedó esperando la decisión sobre skills. */
export interface PendingResume {
  entry: SessionHistoryEntry;
  statuses: SessionSkillStatus[];
}

/**
 * Reabrir una sesión archivada.
 *
 * Vive fuera de la página porque no es presentación: decide si hay que enfocar una tab que
 * ya existe, si hay que preguntar por skills que faltan, y con qué entorno se relanza.
 */
export function useResumeSession() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { checkSessionSkills, restoreSessionSkills } = useSessionsStore();
  const { workspaceId, addTab } = useTabsStore();

  /** Sesión con skills faltantes: se avisa antes de abrirla. */
  const [pendingResume, setPendingResume] = useState<PendingResume | null>(null);
  /** Sesión abierta desde "reanudar con opciones": el usuario elige el set de skills. */
  const [pendingSkillChoice, setPendingSkillChoice] = useState<PendingResume | null>(null);

  /**
   * Si esta conversación ya está abierta en este workspace, la enfoca y devuelve `true`.
   *
   * Se consulta en TODOS los caminos de reanudación: antes solo lo hacía el botón directo,
   * así que reanudar desde cualquiera de los diálogos abría un duplicado de una sesión que
   * ya estaba en pantalla.
   */
  const focusIfAlreadyOpen = async (entry: SessionHistoryEntry): Promise<boolean> => {
    const location = await ipc
      .findOpenTabForSession({
        sessionId: entry.sessionId,
        historyId: entry.id,
        workspaceId,
      })
      .catch(() => null);
    if (!location) return false;

    await focusWindow(location.windowLabel).catch(console.error);
    await broadcastEvent(
      "cc-focus-tab",
      JSON.stringify({ targetLabel: location.windowLabel, tabId: location.tabId })
    ).catch(console.error);
    return true;
  };

  /**
   * Abre la tab de verdad. Sin `skillIds` restaura las skills que la sesión tenía al
   * cerrarse (el camino por defecto); con `skillIds` monta exactamente ese set — es lo que
   * eligió el usuario en `ResumeOptionsDialog`, incluida la lista vacía ("abrir sin
   * skills"), que por eso se distingue de `undefined` y no con un `.length`.
   *
   * `prelaunch` sigue la misma regla: `undefined` = la cadena con la que la sesión corría.
   */
  const openSession = async (
    entry: SessionHistoryEntry,
    skillIds?: string[],
    prelaunch?: PrelaunchStep[]
  ) => {
    if (await focusIfAlreadyOpen(entry)) return;

    const tabId = addTab({
      cwd: entry.cwd,
      agent: {
        id: entry.agentId,
        label: entry.agentLabel,
        command: entry.command,
        available: true,
      },
      sessionId: entry.sessionId ?? undefined,
      // Vincula la tab con la entrada del historial de la que salió: al cerrarla se
      // actualiza ESA entrada en vez de agregar otra copia de la misma sesión.
      historyId: entry.id,
      // Con la MISMA cuenta con la que corría. Sin esto la tab arrancaba con la cuenta
      // principal y el resume no encontraba nada: el transcript vive dentro de la carpeta
      // de la cuenta, no en el home.
      accountId: entry.accountId ?? undefined,
      // Y con los mismos comandos previos: reabrir una sesión tiene que reproducir el
      // entorno en el que se estaba trabajando, no uno pelado. Salvo que se hayan editado
      // en el diálogo de opciones, que es la única oportunidad de cambiarlos (el entorno
      // se hereda al spawnear y no se puede tocar con el agente ya corriendo).
      prelaunch: prelaunch ?? entry.prelaunch,
    });
    navigate("/workspace");

    // Mismo gate que el wizard del "+": los symlinks tienen que estar en disco ANTES de
    // que arranque el agente, porque varios escanean sus skills solo al boot.
    const setup = (async (): Promise<string[]> => {
      if (skillIds === undefined) {
        // La fila de la tab tiene que existir antes de reattachear nada.
        await flushPendingSave();
        try {
          const missing = await restoreSessionSkills(entry.id, workspaceId, tabId);
          // Las que ya no están instaladas no son un fallo del montaje, pero tampoco
          // pueden pasar desapercibidas: la sesión se reabre distinta a como se cerró.
          return missing.map((name) => t("sessions.skillNoLongerInstalled", { name }));
        } catch (e) {
          return [String(e)];
        }
      }
      // Mismo scope que usa `restore_session_skills`: la sesión se reabre como una tab
      // puntual, así que todo entra con scope='tab' aunque en su momento viniera del
      // workspace.
      return attachSkillsToTab(tabId, workspaceId, skillIds);
    })();
    registerPendingSkillSetup(tabId, setup);
  };

  /** Reanudar eligiendo antes las skills: se resuelve su estado actual y se abre el diálogo. */
  const resumeWithOptions = async (entry: SessionHistoryEntry) => {
    if (await focusIfAlreadyOpen(entry)) return;
    const statuses = await checkSessionSkills(entry.id).catch(() => []);
    setPendingSkillChoice({ entry, statuses });
  };

  const resume = async (entry: SessionHistoryEntry) => {
    // Antes de cualquier diálogo: si ya está abierta, esto es un "llevame ahí" y no una
    // reapertura — no tiene sentido preguntar por skills que ya están montadas.
    if (await focusIfAlreadyOpen(entry)) return;

    // Si alguna de las skills que tenía esta sesión ya no está instalada, se avisa ANTES
    // de abrirla: reabrirla sin ellas es una sesión distinta a la que se cerró, y el
    // usuario tiene que poder decidir entre reinstalarlas o seguir igual.
    const statuses = await checkSessionSkills(entry.id).catch(() => []);
    if (statuses.some((s) => !s.installedSkillId)) {
      setPendingResume({ entry, statuses });
      return;
    }

    await openSession(entry);
  };

  return {
    pendingResume,
    setPendingResume,
    pendingSkillChoice,
    setPendingSkillChoice,
    openSession,
    resume,
    resumeWithOptions,
  };
}
