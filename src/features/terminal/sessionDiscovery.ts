import { discoverSessionId } from "@/features/sessions/ipc";

/**
 * Descubrimiento de la sesión real que está usando una tab.
 *
 * El agente puede tardar en escribir su primer log (p. ej. hasta el primer mensaje del
 * usuario), así que no basta con probar solo los primeros segundos tras lanzarlo. Pero
 * cada intento sale a disco: codex/gemini-cli/kimi-code leen la metadata de las sesiones
 * candidatas y opencode levanta un proceso (~0.9s). Repetir eso cada 3s indefinidamente
 * durante toda la vida de una tab que jamás llega a resolverse (agente sin sesión, cwd sin
 * permisos, etc.) es I/O desperdiciado: de ahí el backoff.
 *
 * Pero no se rinde. Antes cortaba a la media hora, y una tab abierta que esperó más que
 * eso su primer mensaje (Claude Code recién crea el transcript ahí) se quedaba sin sesión
 * para siempre: al reabrir la app arrancaba de cero. Pasado el tramo rápido sigue, muy de
 * vez en cuando, mientras la tab esté viva.
 */
const INITIAL_MS = 3000;
const MAX_INTERVAL_MS = 30_000;
/** Cuántos intentos con el backoff normal (~26 minutos). */
const FAST_ATTEMPTS = 60;
/** Después, uno cada tanto: lo justo para enterarse cuando por fin aparezca. */
const SLOW_INTERVAL_MS = 120_000;

/**
 * Margen de seguridad hacia atrás para el piso temporal: los timestamps de archivo tienen
 * resolución de 1s y puede haber un pequeño desfase entre el reloj del frontend y el de
 * `pty_create`.
 */
export const LOOKBACK_S = 3;

export interface DiscoveryOptions {
  agentId: string;
  cwd: string;
  /** Piso temporal (epoch en segundos): nada anterior a esto puede ser esta sesión. */
  startedAfter: number;
  /** Cuenta con la que corre la tab: sus transcripts viven en SU carpeta, no en el home. */
  accountId: string | null;
  onFound: (sessionId: string) => void;
}

/**
 * Arranca el sondeo. Devuelve la función para cancelarlo — hay que llamarla al desmontar:
 * si no, un intento en vuelo puede resolver contra una tab que ya no existe.
 */
export function startSessionDiscovery(opts: DiscoveryOptions): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  const attempt = async () => {
    if (cancelled) return;
    attempts += 1;
    try {
      const found = await discoverSessionId({
        agentId: opts.agentId,
        cwd: opts.cwd,
        startedAfter: opts.startedAfter,
        accountId: opts.accountId,
      });
      if (found) {
        if (!cancelled) opts.onFound(found);
        return;
      }
    } catch {
      // ignorar, se reintenta
    }
    if (!cancelled) {
      const delay = attempts < FAST_ATTEMPTS
        ? Math.min(INITIAL_MS * 2 ** Math.floor(attempts / 3), MAX_INTERVAL_MS)
        : SLOW_INTERVAL_MS;
      timer = setTimeout(attempt, delay);
    }
  };

  timer = setTimeout(attempt, INITIAL_MS);

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
