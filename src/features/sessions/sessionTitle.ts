import { sessionTitle } from "./ipc";
import type { Tab } from "@/features/tabs/types";

/** Pide al backend un título legible derivado de la sesión real del agente. */
export async function refreshSessionTitle(tab: Tab): Promise<string> {
  if (tab.titleIsCustom) return tab.title;
  try {
    const result = await sessionTitle({
      agentId: tab.agentId,
      cwd: tab.cwd,
      sessionId: tab.sessionId ?? null,
      fallback: tab.title,
      accountId: tab.accountId ?? null,
    });
    return result.title;
  } catch {
    return tab.title;
  }
}
