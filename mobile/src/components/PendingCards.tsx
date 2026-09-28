import { useState } from "react";
import { Text, TextInput, View } from "react-native";

import type { DesktopConnection } from "@/lib/connection";
import { type Approval, type Ask, describeApproval, folderName } from "@/lib/types";
import { colors, mono } from "./theme";
import { Button, Card, styles } from "./ui";

/** Un agente de la flota esperando permiso: qué quiere hacer, y Permitir / Denegar. */
export function ApprovalCard({ approval, conn }: { approval: Approval; conn: DesktopConnection }) {
  const [busy, setBusy] = useState<"allow" | "deny" | "remember" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (allow: boolean, remember = false) => {
    setBusy(remember ? "remember" : allow ? "allow" : "deny");
    setError(null);
    try {
      const { decided } = await conn.request<{ decided: boolean }>("approval.decide", { id: approval.id, allow, remember });
      if (!decided) setError("Ya no espera: venció o lo resolvió otro.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ borderColor: colors.warning }}>
      <Text style={[styles.muted, { color: colors.warning }]}>Permiso · {approval.toolName}</Text>
      <Text style={[styles.text, mono, { fontSize: 13 }]} numberOfLines={6}>
        {describeApproval(approval)}
      </Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button title="Permitir" onPress={() => decide(true)} busy={busy === "allow"} disabled={!!busy} style={{ flex: 1 }} />
        <Button title="Denegar" variant="danger" onPress={() => decide(false)} busy={busy === "deny"} disabled={!!busy} style={{ flex: 1 }} />
      </View>
      {approval.suggestedRule ? (
        <Button
          title={`Permitir siempre: ${approval.suggestedRule}`}
          variant="ghost"
          onPress={() => decide(true, true)}
          busy={busy === "remember"}
          disabled={!!busy}
        />
      ) : null}
      {error ? <Text style={[styles.muted, { color: colors.danger }]}>{error}</Text> : null}
    </Card>
  );
}

/** Un agente preguntando algo: botones si trae opciones, texto libre si no. */
export function AskCard({ ask, conn }: { ask: Ask; conn: DesktopConnection }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { answered } = await conn.request<{ answered: boolean }>("ask.answer", { id: ask.id, answer: value });
      if (!answered) setError("Ya no espera respuesta.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ borderColor: colors.accent }}>
      <Text style={[styles.muted, { color: colors.accent }]}>
        Pregunta{ask.cwd ? ` · ${folderName(ask.cwd)}` : ""}
      </Text>
      <Text style={styles.text}>{ask.question}</Text>
      {ask.options.length > 0 ? (
        <View style={{ gap: 8 }}>
          {ask.options.map((option) => (
            <Button key={option} title={option} variant="secondary" onPress={() => answer(option)} disabled={busy} />
          ))}
        </View>
      ) : (
        <View style={[styles.row]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={ask.placeholder ?? "Tu respuesta"}
            placeholderTextColor={colors.faint}
            style={[styles.input, { flex: 1 }]}
            onSubmitEditing={() => answer(text)}
            returnKeyType="send"
          />
          <Button title="Enviar" onPress={() => answer(text)} busy={busy} disabled={!text.trim()} />
        </View>
      )}
      {error ? <Text style={[styles.muted, { color: colors.danger }]}>{error}</Text> : null}
    </Card>
  );
}
