/**
 * Notificaciones: el PC le avisa al teléfono cuando un agente espera un permiso o hace una
 * pregunta y el teléfono no está conectado. El texto es genérico; lo real se ve al abrir.
 *
 * Hace falta un proyecto de EAS (`extra.eas.projectId` en app.json, lo pone `eas init`):
 * es con lo que Expo sabe a qué app entregar. Sin él, la app anda igual, sin avisos.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let token: Promise<string | null> | null = null;

/** El token de Expo de este teléfono, o `null` si no se puede (emulador, sin permiso, sin EAS). */
export function pushToken(): Promise<string | null> {
  token ??= obtain().catch((e) => {
    console.warn("[push] sin notificaciones:", e);
    return null;
  });
  return token;
}

async function obtain(): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Agentes",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== "granted") return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}
