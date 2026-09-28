import { Text, View } from "react-native";

import type { Snapshot } from "@/lib/connection";
import { colors } from "./theme";
import { Dot, styles } from "./ui";

const LABEL: Record<Snapshot["status"], [string, string]> = {
  connecting: ["Conectando…", colors.warning],
  online: ["Conectada", colors.success],
  "pc-offline": ["La computadora no está conectada", colors.faint],
  error: ["Sin conexión", colors.danger],
};

/** El estado de la conexión con un PC, en una línea. */
export function StatusLine({ snapshot }: { snapshot: Snapshot | null }) {
  const [label, color] = LABEL[snapshot?.status ?? "connecting"];
  return (
    <View style={[styles.row, { flexShrink: 1 }]}>
      <Dot color={color} />
      <Text style={styles.muted} numberOfLines={1}>
        {label}
        {snapshot?.error && snapshot.status !== "online" ? ` — ${snapshot.error}` : ""}
      </Text>
    </View>
  );
}
