import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Platform, ScrollView, Text, TextInput, View } from "react-native";

import { colors } from "@/components/theme";
import { Button, Card, styles } from "@/components/ui";
import { parsePairingCode } from "@/protocol/frames";
import { useDesktops } from "@/lib/desktops";
import { pairWith } from "@/lib/pair";
import { pushToken } from "@/lib/push";

/**
 * Emparejar: escanear el QR que muestra Control Code (o pegar su código, si la cámara no
 * anda). El código vence a los 5 minutos y sirve una sola vez.
 */
export default function Pair() {
  const { keys, add } = useDesktops();
  const [permission, requestPermission] = useCameraPermissions();
  const [pasted, setPasted] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const pair = async (text: string) => {
    if (busy.current || !keys) return;
    busy.current = true;
    setError(null);
    try {
      const code = parsePairingCode(text);
      setStatus(`Conectando con ${code.name}…`);
      const desktop = await pairWith(code, keys, {
        name: Device.deviceName ?? Device.modelName ?? "Teléfono",
        platform: Platform.OS,
        pushToken: await pushToken(),
      });
      await add(desktop);
      router.replace(`/desktop/${encodeURIComponent(desktop.id)}`);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
      // Se deja volver a escanear después de un momento: la cámara sigue leyendo el mismo
      // QR varias veces por segundo.
      setTimeout(() => (busy.current = false), 1500);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.text}>
        En Control Code: Configuración → Móvil → «Emparejar un teléfono». Apuntá la cámara al código que aparece.
      </Text>

      {permission?.granted ? (
        <View style={{ aspectRatio: 1, borderRadius: 16, overflow: "hidden", backgroundColor: colors.surface }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => pair(data)}
          />
        </View>
      ) : (
        <Card>
          <Text style={styles.text}>Hace falta la cámara para leer el código.</Text>
          <Button title="Permitir la cámara" onPress={requestPermission} />
        </Card>
      )}

      {status ? <Text style={styles.muted}>{status}</Text> : null}
      {error ? <Text style={[styles.text, { color: colors.danger }]}>{error}</Text> : null}

      <Text style={styles.section}>O pegá el código</Text>
      <TextInput
        value={pasted}
        onChangeText={setPasted}
        placeholder='{"v":1,"relay":…}'
        placeholderTextColor={colors.faint}
        style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button title="Emparejar" onPress={() => pair(pasted)} disabled={!pasted.trim()} />
    </ScrollView>
  );
}
