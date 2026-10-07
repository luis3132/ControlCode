import "@/i18n/index";
import "@fontsource-variable/jetbrains-mono";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "neogestify-ui-components";
import App from "@/app/App";
import { loadAgentRegistry } from "@/features/agents/registry";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { renderingInfo } from "@/shared/ipc/settings";
import { installWheelScrollX } from "@/shared/wheelScrollX";

// El menú de click derecho del webview (Atrás, Recargar, Inspeccionar…) es del navegador,
// no de la app: recargar tira las terminales vivas. Se deja solo donde se escribe texto,
// porque ahí trae cortar, copiar y pegar y la app no tiene otro. Los menús propios (tabs,
// árbol de archivos) llaman a `preventDefault` ellos mismos, así que esto no los toca.
// La terminal cuenta como "no texto" aunque por dentro sea un `<textarea>`: xterm lo mueve
// bajo el puntero al hacer click derecho, y el menú que saldría es el del navegador.
document.addEventListener("contextmenu", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const editable = el?.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
  if (editable && !el?.closest(".xterm")) return;
  e.preventDefault();
});

// La barra de tabs desborda al costado: la rueda la corre en horizontal, sin Shift.
installWheelScrollX();

// El tema inicial (default "dark") ya lo resolvió y persistió el script inline de
// index.html, que corre antes del primer pintado — repetirlo aquí llegaría tarde.

// El catálogo de TUIs se trae ANTES de renderizar. Es un `const` de Rust serializado —
// sin disco ni subprocesos, a diferencia de `detect_agents`— y de él salen los flags de
// reanudación. Si llegara tarde, una terminal restaurada ya se habría lanzado con el
// comando pelado: sesión nueva en vez de la del usuario, y sin ningún error a la vista.
// `loadAgentRegistry` nunca rechaza, así que esto no puede dejar la app sin pintar.
// La fuente de la terminal se pide ANTES de montar: un @font-face no descarga nada hasta
// que algo lo usa, y xterm mide la celda en el momento de abrirse. Midiendo con la de
// respaldo, la grilla sale con otro ancho y la TUI arranca con columnas que no son las
// reales. Con tope de espera: sin la fuente la app abre igual, con la de respaldo.
const terminalFont = Promise.race([
  document.fonts.load('13px "JetBrains Mono Variable"').catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 1500)),
]);

// Si la ventana arrancó sin composición por GPU, la terminal no tiene que intentar WebGL.
const rendering = renderingInfo()
  .then((info) => useTerminalPrefsStore.getState().setCompositing(info.activeNow))
  .catch(() => {});

Promise.all([loadAgentRegistry(), terminalFont, rendering]).then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
});
