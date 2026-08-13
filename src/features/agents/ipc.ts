/** Comandos de agentes: detección de las TUIs instaladas y CRUD de las custom. */
import { invoke } from "@tauri-apps/api/core";

import type { AgentInfo } from "@/features/tabs/types";

import type { CustomAgent, CustomAgentDraft } from "./types";

/** Qué TUIs de las soportadas de fábrica están instaladas en esta máquina. */
export const detectAgents = () => invoke<AgentInfo[]>("detect_agents");

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
