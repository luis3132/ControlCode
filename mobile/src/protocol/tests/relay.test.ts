/**
 * El cliente del teléfono contra el relay de verdad (el binario Rust de `relay/`).
 * Se saltea si el binario no está compilado: `cd relay && cargo build --release`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { RelayClient } from "../client";
import { generateKeys, idOf } from "../crypto";

const BIN = join(import.meta.dir, "../../../../relay/target/release/controlcode-relay");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL = `ws://127.0.0.1:${PORT}/v1/ws`;
const available = existsSync(BIN);

let relay: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  if (!available) return;
  relay = Bun.spawn([BIN, "--addr", `127.0.0.1:${PORT}`, "--token", "tk"], { stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      await Bun.sleep(50);
    }
  }
});

afterAll(() => relay?.kill());

describe.skipIf(!available)("contra el relay de verdad", () => {
  it("un pedido cifrado va del teléfono al PC y vuelve", async () => {
    const pcKeys = generateKeys();
    const pc = new RelayClient({ url: URL, keys: pcKeys, token: "tk", role: "desktop" });
    const phone = new RelayClient({ url: URL, keys: generateKeys(), token: "tk" });
    await pc.connect();
    await phone.connect();

    // El "PC" contesta lo que le piden.
    pc.on("request", ({ from, msg }) => {
      pc.sendInner(from, { k: "res", id: msg.id, ts: Date.now(), ok: true, r: { echo: msg.m, p: msg.p } });
    });

    const presence: boolean[] = [];
    phone.on("presence", ({ online }) => presence.push(online));
    phone.watch([idOf(pcKeys)]);

    const result = await phone.request<{ echo: string; p: unknown }>(idOf(pcKeys), "state", { a: 1 });
    expect(result).toEqual({ echo: "state", p: { a: 1 } });
    expect(presence).toContain(true);

    // Eventos del PC al teléfono.
    const got = new Promise((resolve) => phone.on("event", (e) => resolve(e)));
    pc.sendInner(idOf(phone["options"].keys), { k: "evt", id: "e1", ts: Date.now(), e: "approvals", d: { list: [] } });
    expect(await got).toEqual({ from: idOf(pcKeys), name: "approvals", data: { list: [] } });

    pc.close();
    phone.close();
  });

  it("sin el token el relay no deja entrar", async () => {
    const phone = new RelayClient({ url: URL, keys: generateKeys(), token: "otro" });
    await expect(phone.connect()).rejects.toThrow("token");
  });

  it("a un PC que no está conectado no se le espera la respuesta", async () => {
    const phone = new RelayClient({ url: URL, keys: generateKeys(), token: "tk" });
    await phone.connect();
    const offline = new Promise((resolve) => phone.on("presence", resolve));
    const lost = phone.request(idOf(generateKeys()), "state", {}, 500);
    expect(await offline).toMatchObject({ online: false });
    await expect(lost).rejects.toThrow();
    phone.close();
  });
});
