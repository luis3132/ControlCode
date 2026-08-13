import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverSessionId } from "@/features/sessions/ipc";

import { startSessionDiscovery } from "../sessionDiscovery";

vi.mock("@/features/sessions/ipc", () => ({ discoverSessionId: vi.fn() }));

const discover = vi.mocked(discoverSessionId);

const OPTS = {
  agentId: "claude-code",
  cwd: "/proj",
  startedAfter: 1000,
  accountId: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  discover.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startSessionDiscovery", () => {
  /// No se consulta al instante: el agente todavía no escribió nada y sería un viaje a
  /// disco garantizado en vacío.
  it("espera antes del primer intento", async () => {
    startSessionDiscovery({ ...OPTS, onFound: vi.fn() });
    expect(discover).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith(OPTS);
  });

  it("al encontrarla avisa una sola vez y deja de sondear", async () => {
    const onFound = vi.fn();
    discover.mockResolvedValue("sess-1");
    startSessionDiscovery({ ...OPTS, onFound });

    await vi.advanceTimersByTimeAsync(3000);
    expect(onFound).toHaveBeenCalledExactlyOnceWith("sess-1");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  /// Cada intento sale a disco y para OpenCode levanta un proceso: el intervalo crece en
  /// vez de martillar cada 3s durante toda la vida de una tab que nunca resuelve.
  it("el intervalo crece entre intentos", async () => {
    discover.mockResolvedValue(null);
    startSessionDiscovery({ ...OPTS, onFound: vi.fn() });

    await vi.advanceTimersByTimeAsync(3000);
    expect(discover).toHaveBeenCalledTimes(1);

    // Los tres primeros van cada 3s...
    await vi.advanceTimersByTimeAsync(3000 * 3);
    const trasNueveSegundos = discover.mock.calls.length;
    expect(trasNueveSegundos).toBeGreaterThan(1);

    // ...y a partir de ahí el intervalo se duplica, así que la misma ventana de tiempo
    // produce menos intentos.
    const antes = discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000 * 3);
    expect(discover.mock.calls.length - antes).toBeLessThan(trasNueveSegundos);
  });

  it("se rinde tras el tope de intentos en vez de sondear para siempre", async () => {
    discover.mockResolvedValue(null);
    startSessionDiscovery({ ...OPTS, onFound: vi.fn() });

    // Muy por encima de la ventana que cubre el backoff (~35 minutos).
    await vi.advanceTimersByTimeAsync(4 * 3600 * 1000);
    expect(discover.mock.calls.length).toBeLessThanOrEqual(60);
  });

  it("un error no corta el sondeo: se reintenta", async () => {
    discover.mockRejectedValueOnce(new Error("boom")).mockResolvedValue("sess-2");
    const onFound = vi.fn();
    startSessionDiscovery({ ...OPTS, onFound });

    await vi.advanceTimersByTimeAsync(3000);
    expect(onFound).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(onFound).toHaveBeenCalledWith("sess-2");
  });

  /// Cancelar tiene que cortar TODO, incluido un intento ya en vuelo: si no, la promesa
  /// resuelve contra una tab que ya no existe.
  it("cancelar corta el sondeo y descarta lo que estaba en vuelo", async () => {
    let resolver: (v: string | null) => void = () => {};
    discover.mockImplementation(() => new Promise((r) => { resolver = r; }));
    const onFound = vi.fn();

    const stop = startSessionDiscovery({ ...OPTS, onFound });
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    resolver("sess-tarde");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onFound).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
