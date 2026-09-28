import { describe, expect, it } from "bun:test";

import { generateKeys, idOf } from "../crypto";
import { MAX_SKEW_MS, ReplayGuard, openInner, parsePairingCode, request, sealInner, wsUrl } from "../frames";

describe("código de emparejamiento", () => {
  const desktop = idOf(generateKeys());
  const valid = { v: 1, relay: "wss://r.com", desktop, name: "PC", secret: "abc" };

  it("lee el del QR", () => {
    expect(parsePairingCode(JSON.stringify(valid))).toEqual({ ...valid, token: undefined });
    expect(parsePairingCode(JSON.stringify({ ...valid, token: "t" })).token).toBe("t");
  });

  it("dice qué pasa con uno que no es", () => {
    expect(() => parsePairingCode("https://otra-cosa.com")).toThrow("no es de Control Code");
    expect(() => parsePairingCode(JSON.stringify({ ...valid, v: 9 }))).toThrow("otra versión");
    expect(() => parsePairingCode(JSON.stringify({ ...valid, desktop: "corta" }))).toThrow();
  });
});

describe("wsUrl", () => {
  it("mismo criterio que el PC", () => {
    expect(wsUrl("wss://relay.casa.com")).toBe("wss://relay.casa.com/v1/ws");
    expect(wsUrl("relay.casa.com/")).toBe("wss://relay.casa.com/v1/ws");
    expect(wsUrl("http://192.168.1.5:8787")).toBe("ws://192.168.1.5:8787/v1/ws");
    expect(wsUrl("wss://x.com/otra")).toBe("wss://x.com/otra");
  });
});

describe("mensajes cifrados", () => {
  it("ida y vuelta, y nadie más los abre", () => {
    const [phone, pc, other] = [generateKeys(), generateKeys(), generateKeys()];
    const msg = request("state");
    const body = sealInner(msg, idOf(pc), phone);
    expect(openInner(body, idOf(phone), pc)).toEqual(msg);
    expect(openInner(body, idOf(phone), other)).toBeNull();
    expect(openInner("basura", idOf(phone), pc)).toBeNull();
  });

  it("lo viejo o repetido no pasa", () => {
    const guard = new ReplayGuard();
    const msg = request("approval.decide", { id: "x", allow: true });
    expect(guard.check(msg)).toBe(true);
    expect(guard.check(msg)).toBe(false);
    expect(guard.check({ ...request("x"), ts: Date.now() - MAX_SKEW_MS - 1 })).toBe(false);
  });
});
