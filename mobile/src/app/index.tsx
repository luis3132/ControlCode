import { router } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";

import { StatusLine } from "@/components/StatusLine";
import { colors } from "@/components/theme";
import { Button, Card, Empty, styles } from "@/components/ui";
import { useDesktop, useDesktops } from "@/lib/desktops";
import type { Desktop } from "@/lib/types";

function DesktopRow({ desktop }: { desktop: Desktop }) {
  const { snapshot } = useDesktop(desktop.id);
  const waiting = (snapshot?.state?.approvals.length ?? 0) + (snapshot?.state?.asks.length ?? 0);
  return (
    <Pressable onPress={() => router.push(`/desktop/${encodeURIComponent(desktop.id)}`)}>
      {({ pressed }) => (
        <Card style={{ opacity: pressed ? 0.7 : 1 }}>
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <Text style={styles.title} numberOfLines={1}>{desktop.name}</Text>
            {waiting > 0 ? (
              <View style={{ backgroundColor: colors.warning, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
                <Text style={{ color: colors.bg, fontWeight: "700", fontSize: 12 }}>{waiting}</Text>
              </View>
            ) : null}
          </View>
          <StatusLine snapshot={snapshot} />
          {snapshot?.state ? (
            <Text style={styles.muted}>
              {snapshot.state.tabs.length} {snapshot.state.tabs.length === 1 ? "tab abierta" : "tabs abiertas"}
            </Text>
          ) : null}
        </Card>
      )}
    </Pressable>
  );
}

export default function Home() {
  const { ready, desktops } = useDesktops();
  if (!ready) return <View style={styles.screen} />;

  return (
    <View style={styles.screen}>
      <FlatList
        data={desktops}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.content}
        renderItem={({ item }) => <DesktopRow desktop={item} />}
        ListEmptyComponent={
          <Empty title="Ninguna computadora todavía">
            En Control Code, abrí Configuración → Móvil, activá el control remoto y tocá «Emparejar un teléfono». Después escaneá el código con esta app.
          </Empty>
        }
        ListFooterComponent={<Button title="Agregar computadora" onPress={() => router.push("/pair")} style={{ marginTop: 8 }} />}
      />
    </View>
  );
}
