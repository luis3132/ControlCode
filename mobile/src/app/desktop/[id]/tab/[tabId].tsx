import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TerminalView, type TerminalHandle } from "@/components/terminal/TerminalView";
import { colors, mono } from "@/components/theme";
import { Button, styles } from "@/components/ui";
import { useDesktop } from "@/lib/desktops";

/** Teclas sueltas para lo que una TUI pide y el teclado del teléfono no tiene. */
const KEYS: { label: string; data: string }[] = [
  { label: "Esc", data: "\u001b" },
  { label: "Ctrl-C", data: "\u0003" },
  { label: "Tab", data: "\t" },
  { label: "↑", data: "\u001b[A" },
  { label: "↓", data: "\u001b[B" },
  { label: "←", data: "\u001b[D" },
  { label: "→", data: "\u001b[C" },
  { label: "⏎", data: "\r" },
  { label: "1", data: "1" },
  { label: "2", data: "2" },
  { label: "3", data: "3" },
];

/**
 * Una tab del PC, en vivo: su terminal arriba, y abajo lo que se le escribe. El texto se
 * manda como lo haría una persona (escribir y después Enter); las teclas sueltas van
 * crudas, para moverse por los menús de una TUI.
 */
export default function TabScreen() {
  const { id, tabId, title } = useLocalSearchParams<{ id: string; tabId: string; title?: string }>();
  const { conn, snapshot } = useDesktop(id);
  const insets = useSafeAreaInsets();
  const term = useRef<TerminalHandle>(null);
  const [text, setText] = useState("");
  const [ended, setEnded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  /** Se engancha a la tab: su scrollback, su tamaño, y desde ahí la salida en vivo. */
  const attach = useCallback(() => {
    conn?.attach(tabId).then(
      (a) => {
        setEnded(null);
        setError(null);
        term.current?.reset(a.cols, a.rows, a.scrollback);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [conn, tabId]);

  const online = snapshot?.status === "online";

  useEffect(() => {
    if (!conn || !online) return;
    const off = conn.onTab(tabId, (e) => {
      if (e.kind === "data") term.current?.write(e.data);
      else if (e.kind === "resize") term.current?.resize(e.cols, e.rows);
      else if (e.kind === "exit") setEnded(`El proceso terminó (código ${e.code}).`);
      else if (e.kind === "reattach") attach();
    });
    attach();
    return off;
  }, [conn, online, tabId, attach]);

  const send = async () => {
    if (!conn || !text.trim()) return;
    setSending(true);
    try {
      await conn.request("tab.send", { tabId, text, enter: true });
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const key = (data: string) => conn?.request("tab.keys", { tabId, data }).catch((e) => setError(String(e)));

  const tabTitle = title ?? snapshot?.state?.tabs.find((t) => t.id === tabId)?.title ?? "";

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: tabTitle }} />
      <TerminalView ref={term} />
      {ended || error || !online ? (
        <Text style={[styles.muted, { paddingHorizontal: 12, paddingVertical: 6, color: error ? colors.danger : colors.muted }]}>
          {error ?? ended ?? "Esperando la conexión con la computadora…"}
        </Text>
      ) : null}
      <View style={{ backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: insets.bottom + 6 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, padding: 8 }} keyboardShouldPersistTaps="always">
          {KEYS.map((k) => (
            <Pressable
              key={k.label}
              onPress={() => key(k.data)}
              disabled={!online}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: pressed ? colors.border : colors.surfaceHigh,
                opacity: online ? 1 : 0.4,
              })}
            >
              <Text style={[{ color: colors.text, fontSize: 13 }, mono]}>{k.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={[styles.row, { paddingHorizontal: 8 }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Escribile al agente…"
            placeholderTextColor={colors.faint}
            style={[styles.input, { flex: 1, maxHeight: 120 }]}
            multiline
            editable={online}
          />
          <Button title="Enviar" onPress={send} busy={sending} disabled={!online || !text.trim()} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
