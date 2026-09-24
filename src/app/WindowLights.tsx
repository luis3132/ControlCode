import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { closeWindowWithSave } from "@/app/closeWithSave";

/** Rojo, ámbar y verde, en el orden de macOS. */
const LIGHTS = [
  { key: "close", color: "#ff5f57" },
  { key: "minimize", color: "#febc2e" },
  { key: "maximize", color: "#28c840" },
] as const;

/**
 * Cerrar / minimizar / maximizar.
 *
 * Los estilos van INLINE y no en clases: el `reset` de Tailwind le pone
 * `background-color: transparent` a todo `<button>`, y cualquier hoja que se cuele
 * después con esa misma especificidad deja los tres puntos invisibles — que es
 * exactamente el síntoma que apareció. Inline no compite con nada.
 *
 * El anillo tenue no es decorativo: sobre el gris claro del tema claro, tres círculos
 * planos sin borde se leen como manchas y no como botones.
 */
export function WindowLights() {
  const { t } = useTranslation();
  const win = getCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    win.isMaximized().then(setIsMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(() => {});
    });
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, [win]);

  const act = (key: (typeof LIGHTS)[number]["key"]) => {
    // Cerrar guarda todo antes (con la alerta de progreso) y después cierra por el camino
    // de siempre (ver `closeWithSave`).
    if (key === "close") closeWindowWithSave("button").catch(console.error);
    else if (key === "minimize") win.minimize().catch(console.error);
    else win.toggleMaximize().catch(console.error);
  };

  const label = (key: string) =>
    key === "close" ? t("window.close")
      : key === "minimize" ? t("window.minimize")
        : isMaximized ? t("window.restore") : t("window.maximize");

  return (
    <div
      className="flex items-center shrink-0"
      style={{ gap: 8 }}
      data-tauri-drag-region="false"
    >
      {LIGHTS.map(({ key, color }) => (
        <button
          key={key}
          onClick={() => act(key)}
          title={label(key)}
          aria-label={label(key)}
          style={{
            width: 12,
            height: 12,
            padding: 0,
            border: 0,
            borderRadius: 999,
            backgroundColor: color,
            boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.22)",
            cursor: "pointer",
            flexShrink: 0,
            appearance: "none",
          }}
        />
      ))}
    </div>
  );
}
