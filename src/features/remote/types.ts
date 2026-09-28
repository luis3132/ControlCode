/** Ver `remote::config::RemoteConfig`. */
export interface RemoteConfig {
  enabled: boolean;
  relayUrl: string;
  token: string | null;
  name: string;
}

/** Ver `remote::client::Status`. */
export interface RemoteStatus {
  state: "off" | "connecting" | "connected" | "error";
  error: string | null;
  desktopId: string | null;
}

/** Ver `remote::commands::DeviceView`. */
export interface RemoteDevice {
  id: string;
  name: string;
  platform: string | null;
  hasPush: boolean;
  pairedAt: number;
  lastSeen: number | null;
  online: boolean;
}

/** Ver `remote::commands::PairingView`. */
export interface Pairing {
  svg: string;
  code: string;
  expiresInSecs: number;
}

/** `m:ss` de una cuenta regresiva. */
export function formatCountdown(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
