import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";

import { ApprovalCard, AskCard } from "@/components/PendingCards";
import { StatusLine } from "@/components/StatusLine";
import { colors, mono } from "@/components/theme";
import { Button, Card, Empty, SectionTitle, styles } from "@/components/ui";
import { useDesktop, useDesktops } from "@/lib/desktops";
import { folderName } from "@/lib/types";

/** Un PC: lo que está esperando por vos (permisos, preguntas) y sus tabs. */
export default function DesktopScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { remove } = useDesktops();
  const { desktop, conn, snapshot } = useDesktop(id);
  const [refreshing, setRefreshing] = useState(false);

  if (!desktop || !conn) return <Empty title="Esa computadora ya no está emparejada." />;
  const state = snapshot?.state;

  const refresh = async () => {
    setRefreshing(true);
    await conn.refresh();
    setRefreshing(false);
  };

  const forget = () =>
    Alert.alert("Olvidar esta computadora", `El teléfono deja de poder manejar ${desktop.name}. Para volver, hay que emparejarlo de nuevo.`, [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Olvidar",
        style: "destructive",
        onPress: async () => {
          await conn.request("unpair").catch(() => {});
          await remove(desktop.id);
          router.replace("/");
        },
      },
    ]);

  const online = snapshot?.status === "online";

  return (
    <>
      <Stack.Screen options={{ title: state?.name ?? desktop.name }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
      >
        <StatusLine snapshot={snapshot} />

        {state && (state.approvals.length > 0 || state.asks.length > 0) ? (
          <>
            <SectionTitle>Esperando por vos</SectionTitle>
            {state.approvals.map((a) => <ApprovalCard key={a.id} approval={a} conn={conn} />)}
            {state.asks.map((a) => <AskCard key={a.id} ask={a} conn={conn} />)}
          </>
        ) : null}

        <View style={[styles.row, { justifyContent: "space-between", marginTop: 8 }]}>
          <SectionTitle>Tabs</SectionTitle>
          <Button
            title="Nuevo agente"
            variant="secondary"
            disabled={!online}
            onPress={() => router.push(`/desktop/${encodeURIComponent(desktop.id)}/launch`)}
            style={{ minHeight: 36 }}
          />
        </View>

        {state?.tabs.length ? (
          state.tabs.map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() =>
                router.push({
                  pathname: "/desktop/[id]/tab/[tabId]",
                  params: { id: desktop.id, tabId: tab.id, title: tab.title },
                })
              }
            >
              {({ pressed }) => (
                <Card style={{ opacity: pressed ? 0.7 : 1, gap: 4 }}>
                  <Text style={styles.title} numberOfLines={1}>{tab.title || tab.agentLabel}</Text>
                  <Text style={[styles.muted, mono, { fontSize: 12 }]} numberOfLines={1}>
                    {tab.agentLabel} · {folderName(tab.cwd)}
                  </Text>
                </Card>
              )}
            </Pressable>
          ))
        ) : state ? (
          <Text style={styles.muted}>No hay tabs abiertas.</Text>
        ) : null}

        <Button title="Olvidar esta computadora" variant="ghost" onPress={forget} style={{ marginTop: 24 }} />
      </ScrollView>
    </>
  );
}
