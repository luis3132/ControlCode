import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../store/tabs";

interface SessionTitleResult {
  title: string;
  source: "summary" | "first_message" | "fallback";
}

/** Pide al backend un título legible derivado de la sesión real del agente. */
export async function refreshSessionTitle(tab: Tab): Promise<string> {
  if (tab.titleIsCustom) return tab.title;
  try {
    const result = await invoke<SessionTitleResult>("get_session_title", {
      agentId: tab.agentId,
      cwd: tab.cwd,
      sessionId: tab.sessionId ?? null,
      fallback: tab.title,
    });
    return result.title;
  } catch {
    return tab.title;
  }
}
