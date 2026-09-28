/**
 * Lo que el teléfono guarda: su clave y los PCs emparejados. En el almacenamiento seguro
 * del sistema (Keychain en iOS, Keystore en Android), nunca en texto plano.
 */
import * as SecureStore from "expo-secure-store";

import { decode, encode } from "@/protocol/b64";
import { type Keys, generateKeys, keysFromSecret } from "@/protocol/crypto";
import type { Desktop } from "./types";

const KEY = "device-key";
const DESKTOPS = "desktops";

let cachedKeys: Keys | null = null;

/** La clave del teléfono: se crea la primera vez. Perderla es tener que volver a emparejar. */
export async function deviceKeys(): Promise<Keys> {
  if (cachedKeys) return cachedKeys;
  const stored = await SecureStore.getItemAsync(KEY);
  if (stored) {
    cachedKeys = keysFromSecret(decode(stored));
  } else {
    cachedKeys = generateKeys();
    await SecureStore.setItemAsync(KEY, encode(cachedKeys.secretKey), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }
  return cachedKeys;
}

export async function listDesktops(): Promise<Desktop[]> {
  const raw = await SecureStore.getItemAsync(DESKTOPS);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeDesktops(list: Desktop[]) {
  await SecureStore.setItemAsync(DESKTOPS, JSON.stringify(list));
}

export async function saveDesktop(desktop: Desktop) {
  const list = (await listDesktops()).filter((d) => d.id !== desktop.id);
  await writeDesktops([...list, desktop]);
}

export async function removeDesktop(id: string) {
  await writeDesktops((await listDesktops()).filter((d) => d.id !== id));
}
