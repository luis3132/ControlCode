import { describe, expect, it } from "bun:test";

import vectors from "../../../../relay/tests/vectors.json";
import { decode, encode, utf8 } from "../b64";
import { generateKeys, idOf, keysFromSecret, open, seal } from "../crypto";

/**
 * Los mismos vectores que verifica el lado Rust (`relay/tests/vectors.rs`): si tweetnacl y
 * `crypto_box` dejaran de producir los mismos bytes, el PC y el teléfono no se entenderían.
 */
describe("vectores compartidos con Rust", () => {
  const sender = keysFromSecret(decode(vectors.sender.secret));
  const recipient = keysFromSecret(decode(vectors.recipient.secret));

  it("las claves públicas coinciden", () => {
    expect(idOf(sender)).toBe(vectors.sender.public);
    expect(idOf(recipient)).toBe(vectors.recipient.public);
  });

  for (const c of vectors.cases) {
    it(`cifra igual: ${JSON.stringify(c.message)}`, () => {
      const sealed = seal(utf8.encode(c.message), recipient.publicKey, sender.secretKey, decode(c.nonce));
      expect(encode(sealed)).toBe(c.sealed);
      const opened = open(decode(c.sealed), sender.publicKey, recipient.secretKey);
      expect(opened && utf8.decode(opened)).toBe(c.message);
    });
  }
});

describe("base64url", () => {
  it("coincide con la de Node para cualquier largo", () => {
    for (let n = 0; n < 70; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      const ours = encode(bytes);
      expect(ours).toBe(Buffer.from(bytes).toString("base64url"));
      expect([...decode(ours)]).toEqual([...bytes]);
    }
  });

  it("rechaza lo que no es base64", () => {
    expect(() => decode("a")).toThrow();
    expect(() => decode("ab$c")).toThrow();
  });
});

describe("cajas", () => {
  it("solo las abre su destinatario, y no se pueden alterar", () => {
    const [a, b, c] = [generateKeys(), generateKeys(), generateKeys()];
    const sealed = seal(utf8.encode("hola"), b.publicKey, a.secretKey);
    expect(open(sealed, a.publicKey, c.secretKey)).toBeNull();
    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(open(tampered, a.publicKey, b.secretKey)).toBeNull();
    expect(utf8.decode(open(sealed, a.publicKey, b.secretKey)!)).toBe("hola");
  });
});
