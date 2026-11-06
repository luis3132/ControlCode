/**
 * La pantalla del dispositivo en un canvas: video H.264 en vivo cuando se puede, capturas
 * PNG cuando no.
 *
 * El video sale de `screenrecord` (ver `src-tauri/src/android/stream.rs`) por un socket
 * local, y se decodifica con WebCodecs. Dos detalles:
 * - `screenrecord` no manda nada hasta que algo cambia: la primera imagen es una captura.
 * - El decodificador de WebKitGTK se guarda el último cuadro hasta recibir el siguiente.
 *   Con la pantalla quieta no llega otro, así que cuando el video se aquieta se pide una
 *   captura, que deja la imagen exacta.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { Size } from "./geometry";
import { androidFrame, androidStream } from "./ipc";

export type StreamMessage =
  | {
      kind: "config";
      codec: string;
      /** El tamaño del video. */
      width: number;
      height: number;
      /** El de la pantalla, en la orientación actual: los toques van en estos píxeles. */
      deviceWidth: number;
      deviceHeight: number;
      description: Uint8Array;
    }
  | { kind: "frame"; key: boolean; data: Uint8Array }
  | { kind: "alive" }
  | { kind: "error"; text: string };

/** Corta el stream en mensajes `[largo u32][tipo u8][datos]`, lleguen como lleguen los pedazos. */
export class MessageReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): StreamMessage[] {
    if (this.buf.length === 0) {
      this.buf = chunk;
    } else {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf);
      joined.set(chunk, this.buf.length);
      this.buf = joined;
    }
    const out: StreamMessage[] = [];
    while (this.buf.length >= 4) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = view.getUint32(0);
      if (this.buf.length < 4 + len) break;
      const message = parseMessage(this.buf[4], this.buf.subarray(5, 4 + len));
      if (message) out.push(message);
      this.buf = this.buf.subarray(4 + len);
    }
    // Lo que queda es un pedazo de mensaje: copiarlo suelta el buffer grande de atrás.
    if (this.buf.length > 0 && this.buf.byteOffset > 0) this.buf = this.buf.slice();
    return out;
  }
}

function parseMessage(kind: number, payload: Uint8Array): StreamMessage | null {
  switch (kind) {
    case 0: {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const jsonLen = view.getUint16(0);
      const info = JSON.parse(new TextDecoder().decode(payload.subarray(2, 2 + jsonLen)));
      return { kind: "config", ...info, description: payload.slice(2 + jsonLen) };
    }
    case 1:
      return { kind: "frame", key: payload[0] === 1, data: payload.slice(1) };
    case 2:
      return { kind: "alive" };
    case 3:
      return { kind: "error", text: new TextDecoder().decode(payload) };
    default:
      return null;
  }
}

/** El tamaño de un PNG, de su cabecera. */
export function pngSize(bytes: Uint8Array): Size | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Sin video, una captura detrás de la otra con este respiro. */
const FRAME_EVERY_MS = 250;
/** Cuánto tiene que estar quieto el video para pedir la captura que lo deja exacto. */
const SETTLE_MS = 400;

export interface Screen {
  /** El canvas donde se dibuja; la vista lo monta donde quiere. */
  canvas: HTMLCanvasElement;
  /** El tamaño de la pantalla del dispositivo, en sus píxeles. `null` hasta la primera imagen. */
  size: Size | null;
  /** `video` en vivo, o `frames` (capturas sueltas). */
  mode: "video" | "frames" | null;
  error: string | null;
  /** Con capturas, pedir la próxima ya (después de un toque). */
  kick: () => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useScreen(serial: string | null, shown: boolean): Screen {
  const canvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.className = "block w-full h-full";
    return c;
  }, []);
  const [size, setSize] = useState<Size | null>(null);
  const [mode, setMode] = useState<Screen["mode"]>(null);
  const [error, setError] = useState<string | null>(null);
  const kick = useRef<() => void>(() => {});

  // Otro dispositivo, otra pantalla.
  useEffect(() => setSize(null), [serial]);

  useEffect(() => {
    if (!shown || !serial) return;
    let alive = true;
    const abort = new AbortController();
    const ctx = canvas.getContext("2d");
    /** Sube con cada cuadro de video: una captura pedida antes llega vieja y no se dibuja. */
    let seq = 0;
    let videoOn = false;
    let settle: ReturnType<typeof setTimeout> | null = null;

    const draw = (source: CanvasImageSource, width: number, height: number) => {
      if (!ctx) return;
      // Con video, el canvas tiene su tamaño y la captura se escala a él.
      if (!videoOn && (canvas.width !== width || canvas.height !== height)) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    };

    const still = async () => {
      const asked = seq;
      try {
        const png = new Uint8Array(await androidFrame(serial));
        const pngDims = pngSize(png);
        if (!alive || !pngDims || seq !== asked) return;
        const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
        if (alive && seq === asked) {
          draw(bitmap, pngDims.width, pngDims.height);
          if (!videoOn) setSize(pngDims);
          setError(null);
        }
        bitmap.close();
      } catch (e) {
        if (alive && !videoOn) setError(String(e));
      }
    };

    const video = async () => {
      const url = await androidStream(serial);
      const res = await fetch(url, { signal: abort.signal, cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const messages = new MessageReader();
      let decoder: VideoDecoder | null = null;
      let failed: unknown = null;
      let needKey = true;
      let timestamp = 0;
      try {
        while (alive) {
          const { value, done } = await reader.read();
          if (done) return;
          if (failed) throw failed;
          for (const m of messages.push(value)) {
            if (m.kind === "error") throw new Error(m.text);
            if (m.kind === "config") {
              decoder?.close();
              decoder = new VideoDecoder({
                output: (frame) => {
                  if (alive) draw(frame, canvas.width, canvas.height);
                  frame.close();
                },
                error: (e) => { failed = e; },
              });
              decoder.configure({ codec: m.codec, description: m.description, optimizeForLatency: true });
              videoOn = true;
              canvas.width = m.width;
              canvas.height = m.height;
              setSize({ width: m.deviceWidth, height: m.deviceHeight });
              setMode("video");
              setError(null);
              needKey = true;
            } else if (m.kind === "frame" && decoder?.state === "configured") {
              if (needKey && !m.key) continue;
              needKey = false;
              decoder.decode(new EncodedVideoChunk({ type: m.key ? "key" : "delta", timestamp: (timestamp += 16_667), data: m.data }));
              seq++;
              if (settle) clearTimeout(settle);
              settle = setTimeout(() => void still(), SETTLE_MS);
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
        if (decoder && decoder.state !== "closed") decoder.close();
      }
    };

    const frames = async () => {
      setMode("frames");
      let wake: (() => void) | null = null;
      kick.current = () => wake?.();
      while (alive) {
        const started = performance.now();
        await still();
        const rest = Math.max(0, FRAME_EVERY_MS - (performance.now() - started));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, rest);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    };

    (async () => {
      void still();
      if (typeof VideoDecoder === "undefined") return frames();
      let failures = 0;
      while (alive) {
        try {
          await video();
          failures = 0;
        } catch (e) {
          if (!alive) return;
          failures++;
          console.warn("[android] video", e);
          if (failures >= 2) {
            videoOn = false;
            return frames();
          }
        }
        if (alive) await sleep(800);
      }
    })();

    return () => {
      alive = false;
      abort.abort();
      if (settle) clearTimeout(settle);
      kick.current = () => {};
      setMode(null);
    };
  }, [shown, serial, canvas]);

  return { canvas, size, mode, error, kick: () => kick.current() };
}
