import { describe, expect, it } from "vitest";

import { MessageReader, pngSize } from "../stream";

const message = (kind: number, payload: number[]) => {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1);
  out[4] = kind;
  out.set(payload, 5);
  return out;
};

const config = () => {
  const json = new TextEncoder().encode(
    JSON.stringify({ codec: "avc1.64002a", width: 720, height: 1600, deviceWidth: 1080, deviceHeight: 2400 })
  );
  return message(0, [json.length >> 8, json.length & 255, ...json, 1, 100, 0, 42]);
};

describe("MessageReader", () => {
  it("lee configuración, cuadros, avisos y errores", () => {
    const reader = new MessageReader();
    const all = new Uint8Array([...config(), ...message(1, [1, 0, 0, 0, 2, 0x65, 0x88]), ...message(2, []), ...message(3, [...new TextEncoder().encode("no")])]);
    const out = reader.push(all);
    expect(out.map((m) => m.kind)).toEqual(["config", "frame", "alive", "error"]);
    const first = out[0];
    if (first.kind !== "config") throw new Error();
    expect([first.codec, first.width, first.deviceHeight]).toEqual(["avc1.64002a", 720, 2400]);
    expect([...first.description]).toEqual([1, 100, 0, 42]);
    expect(out[1]).toEqual({ kind: "frame", key: true, data: new Uint8Array([0, 0, 0, 2, 0x65, 0x88]) });
    expect(out[3]).toEqual({ kind: "error", text: "no" });
  });

  it("junta los mensajes que llegan partidos", () => {
    const reader = new MessageReader();
    const bytes = new Uint8Array([...message(1, [0, 9, 9, 9]), ...message(2, [])]);
    const got = [];
    for (const b of bytes) got.push(...reader.push(new Uint8Array([b])));
    expect(got).toEqual([{ kind: "frame", key: false, data: new Uint8Array([9, 9, 9]) }, { kind: "alive" }]);
  });
});

describe("pngSize", () => {
  it("lee el tamaño de la cabecera", () => {
    const head = new Uint8Array(24);
    head.set([0x89, 0x50, 0x4e, 0x47]);
    new DataView(head.buffer).setUint32(16, 1080);
    new DataView(head.buffer).setUint32(20, 2400);
    expect(pngSize(head)).toEqual({ width: 1080, height: 2400 });
    expect(pngSize(new Uint8Array(4))).toBeNull();
  });
});
