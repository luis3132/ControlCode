/**
 * Los mensajes. Espejo de `relay/src/protocol.rs`; el protocolo completo está en
 * `docs/remote-protocol.md`.
 */
import { decode, encode, utf8 } from "./b64";
import { type Keys, idOf, open, publicKey, randomBytes, seal } from "./crypto";

export const VERSION = 1;

export type Role = "desktop" | "device";

export type ClientFrame =
  | { t: "hello"; role: Role; key: string; proof: string; token?: string }
  | { t: "send"; to: string; body: string }
  | { t: "watch"; ids: string[] };

export type ServerFrame =
  | { t: "challenge"; relay: string; challenge: string }
  | { t: "ready"; id: string }
  | { t: "error"; code: string; message: string }
  | { t: "msg"; from: string; body: string }
  | { t: "undelivered"; to: string }
  | { t: "presence"; id: string; online: boolean };

export type Inner =
  | { k: "req"; id: string; ts: number; m: string; p: unknown }
  | { k: "res"; id: string; ts: number; ok: boolean; r?: unknown; e?: string }
  | { k: "evt"; id: string; ts: number; e: string; d: unknown };

/** Lo que va en el QR que muestra Control Code. */
export interface PairingCode {
  v: number;
  relay: string;
  token?: string;
  desktop: string;
  name: string;
  secret: string;
}

/** Id aleatorio de mensaje. Usa la fuente de `tweetnacl`, que en React Native es la de
 *  `expo-crypto` (ver `lib/random.ts`): ahí no hay `crypto` global. */
export function newId(): string {
  return encode(randomBytes(16));
}

export function request(method: string, params: unknown = {}): Inner & { k: "req" } {
  return { k: "req", id: newId(), ts: Date.now(), m: method, p: params };
}

/** El `hello` que contesta al desafío: prueba que tenemos la clave secreta. */
export function hello(keys: Keys, role: Role, relay: string, challenge: string, token?: string): ClientFrame {
  const proof = seal(decode(challenge), publicKey(relay), keys.secretKey);
  return { t: "hello", role, key: idOf(keys), proof: encode(proof), ...(token ? { token } : {}) };
}

export function sealInner(msg: Inner, peer: string, keys: Keys): string {
  return encode(seal(utf8.encode(JSON.stringify(msg)), publicKey(peer), keys.secretKey));
}

/** `null` si no se puede abrir o no es un mensaje válido. */
export function openInner(body: string, from: string, keys: Keys): Inner | null {
  try {
    const plain = open(decode(body), publicKey(from), keys.secretKey);
    if (!plain) return null;
    const msg = JSON.parse(utf8.decode(plain));
    if (!msg || typeof msg.id !== "string" || typeof msg.ts !== "number" || !["req", "res", "evt"].includes(msg.k)) {
      return null;
    }
    return msg as Inner;
  } catch {
    return null;
  }
}

/**
 * Lee lo que se escaneó (o se pegó). Tira un error legible si no es un código de Control
 * Code: la cámara lee cualquier QR que tenga delante.
 */
export function parsePairingCode(text: string): PairingCode {
  let data: unknown;
  try {
    data = JSON.parse(text.trim());
  } catch {
    throw new Error("Ese código no es de Control Code.");
  }
  const c = data as Partial<PairingCode>;
  if (typeof c !== "object" || c === null || typeof c.desktop !== "string" || typeof c.secret !== "string" || typeof c.relay !== "string") {
    throw new Error("Ese código no es de Control Code.");
  }
  if (c.v !== VERSION) throw new Error("Ese código es de otra versión de Control Code. Actualizá la app.");
  publicKey(c.desktop);
  return {
    v: c.v,
    relay: c.relay,
    token: typeof c.token === "string" && c.token ? c.token : undefined,
    desktop: c.desktop,
    name: typeof c.name === "string" && c.name ? c.name : "Control Code",
    secret: c.secret,
  };
}

/** La URL del socket a partir de la dirección base del relay. Mismo criterio que `remote::config::ws_url`. */
export function wsUrl(relay: string): string {
  let url = relay.trim().replace(/\/+$/, "");
  if (url.startsWith("https://")) url = "wss://" + url.slice(8);
  else if (url.startsWith("http://")) url = "ws://" + url.slice(7);
  else if (!/^wss?:\/\//.test(url)) url = "wss://" + url;
  const rest = url.replace(/^wss?:\/\//, "");
  return rest.includes("/") ? url : `${url}/v1/ws`;
}

export const MAX_SKEW_MS = 5 * 60 * 1000;
const SEEN_TTL_MS = 11 * 60 * 1000;

/** Rechaza lo viejo o repetido (el relay podría reenviar un mensaje). */
export class ReplayGuard {
  private seen = new Map<string, number>();

  check(msg: Inner, now = Date.now()): boolean {
    if (Math.abs(now - msg.ts) > MAX_SKEW_MS) return false;
    for (const [id, at] of this.seen) if (now - at >= SEEN_TTL_MS) this.seen.delete(id);
    if (this.seen.has(msg.id)) return false;
    this.seen.set(msg.id, now);
    return true;
  }
}
