/**
 * El teléfono (TypeScript) contra un PC escrito en Rust (`relay/examples/echo_desktop.rs`),
 * con el relay de verdad en el medio. Es lo que prueba que los dos lados arman y leen el
 * mismo JSON cifrado, y no solo los mismos bytes de cifrado.
 *
 * Necesita los binarios: `cd relay && cargo build --release --example echo_desktop`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { RelayClient } from "../client";
import { generateKeys } from "../crypto";

const RELEASE = join(import.meta.dir, "../../../../relay/target/release");
const RELAY = join(RELEASE, "controlcode-relay");
const DESKTOP = join(RELEASE, "examples/echo_desktop");
const PORT = 20000 + Math.floor(Math.random() * 1000);
const URL = `ws://127.0.0.1:${PORT}/v1/ws`;
const available = existsSync(RELAY) && existsSync(DESKTOP);

const procs: ReturnType<typeof Bun.spawn>[] = [];
let desktopId = "";

beforeAll(async () => {
  if (!available) return;
  procs.push(Bun.spawn([RELAY, "--addr", `127.0.0.1:${PORT}`], { stderr: "ignore" }));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
    } catch {
      await Bun.sleep(50);
    }
  }
  const desktop = Bun.spawn([DESKTOP, URL], { stdout: "pipe", stderr: "ignore" });
  procs.push(desktop);
  const reader = desktop.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  desktopId = out.match(/READY (\S+)/)?.[1] ?? "";
});

afterAll(() => procs.forEach((p) => p.kill()));

describe.skipIf(!available)("contra un PC en Rust", () => {
  it("pedido, respuesta y evento se entienden de los dos lados", async () => {
    expect(desktopId).toHaveLength(43);
    const phone = new RelayClient({ url: URL, keys: generateKeys() });
    await phone.connect();
    const event = new Promise((resolve) => phone.on("event", resolve));

    const params = { tabId: "t1", text: "hola ñandú ✓", enter: true };
    const result = await phone.request(desktopId, "tab.send", params);
    expect(result).toEqual({ method: "tab.send", params });

    expect(await event).toEqual({ from: desktopId, name: "approvals", data: { list: [{ id: "a1", toolName: "Bash" }] } });
    phone.close();
  });
});
