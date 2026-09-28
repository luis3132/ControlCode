/**
 * Emparejar con un PC a partir de lo que se leyó del QR.
 *
 * El QR trae la clave pública del PC (por un canal que el relay no ve: la pantalla) y un
 * secreto de un solo uso que prueba ante el PC que el pedido viene de quien lo escaneó.
 */
import { RelayClient } from "@/protocol/client";
import type { Keys } from "@/protocol/crypto";
import { type PairingCode, wsUrl } from "@/protocol/frames";
import type { Desktop } from "./types";

export interface DeviceInfo {
  name: string;
  platform: string;
  pushToken?: string | null;
}

export async function pairWith(
  code: PairingCode,
  keys: Keys,
  device: DeviceInfo,
  WebSocketImpl?: typeof WebSocket,
): Promise<Desktop> {
  const client = new RelayClient({ url: wsUrl(code.relay), keys, token: code.token, WebSocketImpl });
  try {
    await client.connect();
    const result = await client.request<{ name: string }>(code.desktop, "pair", {
      secret: code.secret,
      name: device.name,
      platform: device.platform,
      ...(device.pushToken ? { pushToken: device.pushToken } : {}),
    }, 15_000);
    return {
      id: code.desktop,
      name: result?.name || code.name,
      relay: code.relay,
      ...(code.token ? { token: code.token } : {}),
      pairedAt: Date.now(),
    };
  } finally {
    client.close();
  }
}
