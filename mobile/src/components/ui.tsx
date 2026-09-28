import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, radius } from "./theme";

type Variant = "primary" | "secondary" | "danger" | "ghost";

export function Button({ title, onPress, variant = "primary", disabled, busy, style }: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const bg = { primary: colors.accent, secondary: colors.surfaceHigh, danger: colors.danger, ghost: "transparent" }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
        variant === "ghost" && { borderWidth: 1, borderColor: colors.border },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.section}>{children}</Text>;
}

export function Dot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {children ? <Text style={styles.emptyText}>{children}</Text> : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: radius, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  card: { backgroundColor: colors.surface, borderRadius: radius, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 8 },
  section: { color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", marginTop: 8 },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  text: { color: colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.muted, fontSize: 13 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  empty: { alignItems: "center", paddingVertical: 48, paddingHorizontal: 24, gap: 8 },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: "600", textAlign: "center" },
  emptyText: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: "center" },
  input: {
    backgroundColor: colors.surfaceHigh,
    color: colors.text,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
});
