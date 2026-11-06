/** El dispositivo Android por adb. Ver `src-tauri/src/android`. */
import { invoke } from "@tauri-apps/api/core";

export interface AndroidDevice {
  serial: string;
  /** `device` (listo), `unauthorized`, `offline`… */
  state: string;
  model: string | null;
  product: string | null;
  emulator: boolean;
}

export interface AndroidStatus {
  /** Dónde está `adb`; `null` = no hay, y la vista no se ofrece. */
  adb: string | null;
  devices: AndroidDevice[];
  /** Emuladores que se pueden arrancar. */
  avds: string[];
}

/** Lo que hace la persona sobre la pantalla, en píxeles del dispositivo. */
export type UserInput =
  /** El dedo en vivo: baja, se mueve y sube. */
  | { kind: "down"; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "up"; x: number; y: number }
  | { kind: "tap"; x: number; y: number }
  | { kind: "hold"; x: number; y: number; ms: number }
  | { kind: "swipe"; x: number; y: number; x2: number; y2: number; ms: number }
  | { kind: "key"; key: string }
  | { kind: "text"; text: string };

/** Si hay adb. Con `devices`, también qué hay conectado — eso levanta el daemon de adb,
 *  así que solo lo pide la vista. */
export const androidStatus = (devices: boolean) => invoke<AndroidStatus>("android_status", { devices });

/** Un cuadro de la pantalla en PNG. Llega crudo, sin JSON. */
export async function androidFrame(serial: string): Promise<ArrayBuffer> {
  const png = await invoke<ArrayBuffer | number[]>("android_frame", { serial });
  return png instanceof ArrayBuffer ? png : new Uint8Array(png).buffer;
}

/** La dirección del video en vivo de la pantalla (un socket local; ver `stream.ts`). */
export const androidStream = (serial: string) => invoke<string>("android_stream", { serial });

/** Va a la cola del dispositivo y vuelve enseguida; los errores llegan por el evento
 *  `android-input-error`. */
export const androidInput = (serial: string, action: UserInput) => invoke<void>("android_input", { serial, action });

export const androidSelect = (serial: string | null) => invoke<void>("android_select", { serial });

export const androidStartAvd = (name: string) => invoke<void>("android_start_avd", { name });

export function deviceName(device: AndroidDevice): string {
  return device.model ? device.model.replace(/_/g, " ") : device.serial;
}
