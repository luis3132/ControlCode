import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";

import { colors, mono } from "@/components/theme";
import { Button, Card, SectionTitle, styles } from "@/components/ui";
import { useDesktop } from "@/lib/desktops";
import { type LaunchOptions, folderName } from "@/lib/types";

function Choice({ label, detail, selected, onPress }: { label: string; detail?: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <Card style={{ borderColor: selected ? colors.accent : colors.border, gap: 2, paddingVertical: 10 }}>
        <Text style={styles.title}>{label}</Text>
        {detail ? <Text style={[styles.muted, mono, { fontSize: 11 }]} numberOfLines={1}>{detail}</Text> : null}
      </Card>
    </Pressable>
  );
}

/** Abrir un agente en una carpeta del PC, con un primer pedido opcional. */
export default function Launch() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { desktop, conn } = useDesktop(id);
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    conn?.launchOptions()
      .then((o) => {
        setOptions(o);
        setAgent(o.agents.find((a) => a.id !== "bash")?.id ?? o.agents[0]?.id ?? null);
        setFolder(o.folders[0] ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [conn]);

  const launch = async () => {
    if (!conn || !desktop || !agent || !folder) return;
    setBusy(true);
    setError(null);
    try {
      // Con prompt, el PC espera a que el agente arranque antes de escribirle: puede tardar.
      const { tabId } = await conn.request<{ tabId: string }>("tab.create", { cwd: folder, agent, prompt }, 90_000);
      await conn.refresh();
      router.dismiss();
      router.push({ pathname: "/desktop/[id]/tab/[tabId]", params: { id: desktop.id, tabId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {!options && !error ? <Text style={styles.muted}>Cargando…</Text> : null}
      {options ? (
        <>
          <SectionTitle>Agente</SectionTitle>
          {options.agents.map((a) => (
            <Choice key={a.id} label={a.label} selected={agent === a.id} onPress={() => setAgent(a.id)} />
          ))}
          <SectionTitle>Carpeta</SectionTitle>
          {options.folders.length === 0 ? (
            <Text style={styles.muted}>No hay carpetas recientes: abrí una en Control Code primero.</Text>
          ) : (
            options.folders.map((f) => (
              <Choice key={f} label={folderName(f)} detail={f} selected={folder === f} onPress={() => setFolder(f)} />
            ))
          )}
          <SectionTitle>Primer pedido (opcional)</SectionTitle>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="¿Qué tiene que hacer?"
            placeholderTextColor={colors.faint}
            style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            multiline
          />
          <Button title="Abrir" onPress={launch} busy={busy} disabled={!agent || !folder} />
        </>
      ) : null}
      {error ? <Text style={[styles.text, { color: colors.danger }]}>{error}</Text> : null}
    </ScrollView>
  );
}
