/**
 * Claves y cifrado de punta a punta: `crypto_box` de NaCl, con `tweetnacl`. Es la misma
 * construcción que usa el lado Rust (`crypto_box`), byte a byte: lo prueban los vectores
 * de `relay/tests/vectors.json` (ver `tests/crypto.test.ts`).
 *
 * `seal` = nonce(24) ‖ caja.
 */
import nacl from "tweetnacl";

import { decode, encode } from "./b64";

export interface Keys {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export const NONCE_LEN = nacl.box.nonceLength;

export function generateKeys(): Keys {
  return nacl.box.keyPair();
}

export function keysFromSecret(secret: Uint8Array): Keys {
  return nacl.box.keyPair.fromSecretKey(secret);
}

/** La identidad: la clave pública en base64url. */
export const idOf = (keys: Keys) => encode(keys.publicKey);

export function publicKey(id: string): Uint8Array {
  const key = decode(id);
  if (key.length !== nacl.box.publicKeyLength) throw new Error("clave inválida");
  return key;
}

export function seal(message: Uint8Array, peer: Uint8Array, secret: Uint8Array, nonce = nacl.randomBytes(NONCE_LEN)): Uint8Array {
  const boxed = nacl.box(message, nonce, peer, secret);
  const out = new Uint8Array(NONCE_LEN + boxed.length);
  out.set(nonce);
  out.set(boxed, NONCE_LEN);
  return out;
}

/** `null` si no la cerró el dueño de `peer` para nosotros, o si alguien la tocó. */
export function open(sealed: Uint8Array, peer: Uint8Array, secret: Uint8Array): Uint8Array | null {
  if (sealed.length < NONCE_LEN + nacl.box.overheadLength) return null;
  return nacl.box.open(sealed.subarray(NONCE_LEN), sealed.subarray(0, NONCE_LEN), peer, secret);
}

export const randomBytes = (n: number) => nacl.randomBytes(n);

/** Para plataformas sin `crypto.getRandomValues` (React Native): ver `lib/random.ts`. */
export function setRandomSource(fill: (bytes: Uint8Array) => void) {
  nacl.setPRNG((x, n) => {
    const bytes = new Uint8Array(n);
    fill(bytes);
    for (let i = 0; i < n; i++) x[i] = bytes[i];
  });
}
