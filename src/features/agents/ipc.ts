/** Comandos de agentes: detección de las TUIs instaladas y CRUD de las custom. */
import { invoke } from "@tauri-apps/api/core";

import type { AgentInfo } from "@/features/tabs/types";

import type { CustomAgent, CustomAgentDraft } from "./types";

/** Qué TUIs de las soportadas de fábrica están instaladas en esta máquina. */
export const detectAgents = () => invoke<AgentInfo[]>("detect_agents");

/**
 * Dónde busca la app los programas (ver `src-tauri/src/util/path_env.rs`).
 *
 * El PATH de una app abierta desde el escritorio no es el de la terminal, así que al
 * arrancar se le pregunta al shell del usuario y se suman las carpetas donde instalan las
 * TUIs. Esto dice qué salió de cada lado: es lo que hace falta ver cuando una TUI que anda
 * en la terminal no aparece en la app.
 */
export interface SearchPath {
  shell: string | null;
  shellOk: boolean;
  shellError: string | null;
  /** Carpetas que dio el shell y que la app no tenía al abrirse. */
  fromShell: string[];
  /** Carpetas de instalación conocidas que se sumaron al final. */
  known: string[];
  effective: string[];
}

export const agentSearchPath = () => invoke<SearchPath>("agent_search_path");

export const listCustomAgents = () => invoke<CustomAgent[]>("list_custom_agents");

export const upsertCustomAgent = (agent: CustomAgentDraft) =>
  invoke<void>("upsert_custom_agent", {
    id: agent.id ?? null,
    label: agent.label,
    command: agent.command,
    resumeArgs: agent.resumeArgs || null,
    skillsDir: agent.skillsDir || null,
    sessionsDir: agent.sessionsDir || null,
    sessionIdFrom: agent.sessionIdFrom || "filename",
    env: agent.env ?? {},
  });

export const deleteCustomAgent = (id: string) => invoke<void>("delete_custom_agent", { id });

/** Sube las TUIs que hubieran quedado en `localStorage`. Ignora ids ya presentes. */
export const importLegacyCustomAgents = (agents: unknown[]) =>
  invoke<void>("import_legacy_custom_agents", { agents });
