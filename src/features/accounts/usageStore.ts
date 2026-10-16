import { create } from "zustand";

import { accountEnv, codexAccountUsage } from "./ipc";
import type { AgentAccount, CodexUsage } from "./types";
import { agentAccountUsage, claudeLiveUsage, isUsageFresh, planLabel, type LiveUsage } from "./usage";

const isSystem = (a: AgentAccount) => a.id.startsWith("system:");
const nowSecs = () => Math.floor(Date.now() / 1000);

export interface CodexEntry {
  /** `null` = todavía no se supo. */
  usage: CodexUsage | null;
  /** Por qué falló la última consulta; lo último bueno se sigue mostrando. */
  problem: string | null;
}

/**
 * Qué hace `refresh`:
 * - `cache`: solo lo guardado. Es lo de arrancar la app: los anillos de la barra se llenan
 *   sin levantar ninguna TUI.
 * - `stale`: lo guardado, y si venció, se vuelve a preguntar detrás. Es abrir el panel.
 * - `force`: preguntar ya. Es el botón de actualizar.
 */
export type RefreshMode = "cache" | "stale" | "force";

interface UsageState {
  claude: Record<string, LiveUsage>;
  codex: Record<string, CodexEntry>;
  /** El plan de cada cuenta de Claude (el sello del encabezado). */
  plan: Record<string, string | null>;
  busy: Record<string, boolean>;
  refresh: (account: AgentAccount, mode: RefreshMode) => Promise<void>;
}

const patch = <K extends "claude" | "codex" | "plan" | "busy">(key: K, id: string, value: UsageState[K][string]) =>
  (s: UsageState) => ({ [key]: { ...s[key], [id]: value } }) as unknown as Pick<UsageState, K>;

const failedLive = (problem: string): LiveUsage => ({
  available: false, session: null, week: null, weekModels: [], fetchedAt: 0, cached: false, problem,
});

/**
 * El cupo de todas las cuentas en un solo lugar: los anillos de la barra y el panel leen de
 * acá, así que abrir o cerrar el panel no vuelve a preguntar ni lo deja en blanco.
 *
 * Preguntarle a Claude cuesta levantar su TUI entera (`/usage`), así que nunca se hace en
 * segundo plano: solo con el panel abierto, y solo si lo guardado venció.
 */
export const useUsageStore = create<UsageState>((set, get) => ({
  claude: {},
  codex: {},
  plan: {},
  busy: {},

  async refresh(account, mode) {
    const id = account.id;
    if (get().busy[id]) return;
    set(patch("busy", id, true));
    try {
      if (account.agentId === "claude-code") {
        const env = isSystem(account) ? {} : await accountEnv(id);
        let live = await claudeLiveUsage(id, env, mode === "force", mode === "cache");
        // En `cache`, nada guardado (`fetchedAt` 0) no es un fallo: es que nunca se preguntó.
        if (mode === "cache" && live.fetchedAt === 0) return;
        set(patch("claude", id, live));
        // Lo guardado puede estar vencido: se muestra al instante y se pregunta detrás.
        const stale = !live.available || !isUsageFresh(live.fetchedAt, nowSecs());
        if (mode === "stale" && live.cached && stale) {
          live = await claudeLiveUsage(id, env, true);
          set(patch("claude", id, live));
        }
        if (get().plan[id] === undefined) {
          const u = await agentAccountUsage(account.agentId, isSystem(account) ? null : id).catch(() => null);
          set(patch("plan", id, planLabel(u?.plan.tier ?? null)));
        }
      } else if (account.agentId === "codex") {
        try {
          let usage = await codexAccountUsage(id, mode === "force");
          // Un `fetchedAt` 0 no es un fallo: es que nunca se preguntó.
          if (usage.fetchedAt > 0 || mode !== "cache") set(patch("codex", id, { usage, problem: null }));
          if (mode === "stale" && !isUsageFresh(usage.fetchedAt, nowSecs())) {
            usage = await codexAccountUsage(id, true);
            set(patch("codex", id, { usage, problem: null }));
          }
        } catch (e) {
          set(patch("codex", id, { usage: get().codex[id]?.usage ?? null, problem: String(e) }));
        }
      }
    } catch (e) {
      if (account.agentId === "claude-code") set(patch("claude", id, failedLive(String(e))));
    } finally {
      set(patch("busy", id, false));
    }
  },
}));

/** Los agentes de los que se sabe leer un cupo. */
export const measurable = (agentId: string) => agentId === "claude-code" || agentId === "codex";

/**
 * Cuánto lleva usada la ventana corta de una cuenta, de 0 a 100, o `null` si no se sabe.
 * Es lo que muestra el anillo. Con Codex en el plan gratis no hay ventana corta: va la
 * única que hay.
 */
export function useHeadline(account: AgentAccount): number | null {
  return useUsageStore((s) => {
    if (account.agentId === "claude-code") {
      const live = s.claude[account.id];
      return live?.available ? live.session?.percent ?? live.week?.percent ?? null : null;
    }
    if (account.agentId === "codex") {
      const q = s.codex[account.id]?.usage?.quota;
      const w = q?.fiveHour ?? q?.sevenDay;
      return w ? Math.round(w.utilization * 100) : null;
    }
    return null;
  });
}

/**
 * Las dos ventanas de una cuenta, de 0 a 100: la corta (sesión de 5 h) y la de la semana.
 * `null` en la que no se sabe o no existe. Es lo que muestra el anillo doble de la barra.
 */
export function useUsageWindows(account: AgentAccount): { session: number | null; week: number | null } {
  const session = useUsageStore((s) => {
    if (account.agentId === "claude-code") {
      const live = s.claude[account.id];
      return live?.available ? live.session?.percent ?? null : null;
    }
    if (account.agentId === "codex") {
      const w = s.codex[account.id]?.usage?.quota?.fiveHour;
      return w ? Math.round(w.utilization * 100) : null;
    }
    return null;
  });
  const week = useUsageStore((s) => {
    if (account.agentId === "claude-code") {
      const live = s.claude[account.id];
      return live?.available ? live.week?.percent ?? null : null;
    }
    if (account.agentId === "codex") {
      const w = s.codex[account.id]?.usage?.quota?.sevenDay;
      return w ? Math.round(w.utilization * 100) : null;
    }
    return null;
  });
  return { session, week };
}
