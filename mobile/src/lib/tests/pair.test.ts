/**
 * Emparejar de punta a punta contra el relay de verdad, con un "PC" en TypeScript que
 * contesta como Control Code (acepta el secreto una sola vez).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { RelayClient } from "@/protocol/client";
import { encode } from "@/protocol/b64";
import { generateKeys, idOf, randomBytes } from "@/protocol/crypto";
import { pairWith } from "../pair";

const BIN = join(import.meta.dir, "../../../../relay/target/release/controlcode-relay");
const PORT = 19000 + Math.floor(Math.random() * 1000);
const available = existsSync(BIN);
let relay: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  if (!available) return;
  relay = Bun.spawn([BIN, "--addr", `127.0.0.1:${PORT}`], { stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      await Bun.sleep(50);
    }
  }
});
afterAll(() => relay?.kill());

describe.skipIf(!available)("emparejar", () => {
  it("con el secreto del QR, una sola vez", async () => {
    const pcKeys = generateKeys();
    let secret: string | null = encode(randomBytes(32));
    const pc = new RelayClient({ url: `ws://127.0.0.1:${PORT}/v1/ws`, keys: pcKeys, role: "desktop" });
    await pc.connect();
    pc.on("request", ({ from, msg }) => {
      const p = msg.p as { secret?: string };
      const ok = msg.m === "pair" && secret !== null && p.secret === secret;
      if (ok) secret = null;
      pc.sendInner(from, ok
        ? { k: "res", id: msg.id, ts: Date.now(), ok: true, r: { name: "PC de prueba" } }
        : { k: "res", id: msg.id, ts: Date.now(), ok: false, e: "El código venció o ya se usó." });
    });

    const code = { v: 1, relay: `http://127.0.0.1:${PORT}`, desktop: idOf(pcKeys), name: "PC", secret: secret! };
    const desktop = await pairWith(code, generateKeys(), { name: "iPhone", platform: "ios" });
    expect(desktop).toMatchObject({ id: idOf(pcKeys), name: "PC de prueba", relay: code.relay });

    await expect(pairWith(code, generateKeys(), { name: "otro", platform: "android" })).rejects.toThrow("ya se usó");
    pc.close();
  });
});
