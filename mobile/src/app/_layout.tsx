import "@/lib/random";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { colors } from "@/components/theme";
import { allConnections } from "@/lib/connection";
import { DesktopsProvider } from "@/lib/desktops";

/**
 * En segundo plano se cierran las conexiones: el sistema las cortaría igual, y así el PC
 * se entera enseguida de que el teléfono no está mirando y avisa por notificación. Al
 * volver, se reconecta y se trae el estado entero.
 */
function useForegroundConnections() {
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      for (const conn of allConnections()) {
        if (state === "active") conn.start();
        else if (state === "background") conn.stop();
      }
    });
    return () => sub.remove();
  }, []);
}

export default function RootLayout() {
  useForegroundConnections();
  return (
    <SafeAreaProvider>
      <DesktopsProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            headerTitleStyle: { fontWeight: "600" },
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="index" options={{ title: "Control Code" }} />
          <Stack.Screen name="pair" options={{ title: "Agregar computadora", presentation: "modal" }} />
          <Stack.Screen name="desktop/[id]/index" options={{ title: "" }} />
          <Stack.Screen name="desktop/[id]/launch" options={{ title: "Nuevo agente", presentation: "modal" }} />
          <Stack.Screen name="desktop/[id]/tab/[tabId]" options={{ title: "" }} />
        </Stack>
      </DesktopsProvider>
    </SafeAreaProvider>
  );
}
