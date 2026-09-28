/**
 * La terminal de una tab del PC, dibujada con xterm.js dentro de una WebView.
 *
 * Tiene SIEMPRE las mismas columnas y filas que la terminal del PC: una TUI (Claude Code,
 * Codex…) posiciona el cursor por columna, y con otro ancho se vería desarmada. Para que
 * entre en la pantalla se achica la letra; con dos dedos se puede hacer zoom.
 *
 * Es solo para mirar: lo que se escribe va por la barra de abajo (ver la pantalla de la
 * tab), no por el teclado de la WebView, que en un teléfono es poco confiable.
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from "react";
import { StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { colors } from "../theme";
import { XTERM_CSS, XTERM_JS } from "./xterm.generated";

export interface TerminalHandle {
  /** Borra todo y dibuja `data` con ese tamaño (al engancharse). */
  reset: (cols: number, rows: number, data: string) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

const PAGE = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes">
<style>${XTERM_CSS}
html, body { margin: 0; background: ${colors.bg}; }
#t { padding: 6px; }
.xterm-viewport { overflow-y: hidden !important; }
</style></head>
<body><div id="t"></div>
<script>${XTERM_JS}</script>
<script>
(function () {
  var term = new Terminal({
    cols: 80, rows: 24, fontSize: 11, scrollback: 3000, disableStdin: true, cursorBlink: false,
    fontFamily: "Menlo, 'DejaVu Sans Mono', monospace",
    theme: { background: "${colors.bg}", foreground: "${colors.text}", cursor: "${colors.accent}" }
  });
  term.open(document.getElementById("t"));
  // La letra que hace entrar las columnas del PC en el ancho del teléfono. Un carácter
  // monoespaciado mide ~0.6 de su alto.
  function fit(cols, rows) {
    var width = window.innerWidth - 12;
    var size = Math.max(5, Math.min(14, Math.floor(width / (cols * 0.6))));
    term.options.fontSize = size;
    term.resize(cols, rows);
  }
  window.cc = {
    reset: function (cols, rows, data) { term.reset(); fit(cols, rows); term.write(data, function () { window.scrollTo(0, document.body.scrollHeight); }); },
    write: function (data) { term.write(data); },
    resize: function (cols, rows) { fit(cols, rows); }
  };
  window.ReactNativeWebView.postMessage("ready");
})();
</script></body></html>`;

export const TerminalView = forwardRef<TerminalHandle>(function TerminalView(_, ref) {
  const web = useRef<WebView>(null);
  const ready = useRef(false);
  const queue = useRef<string[]>([]);

  const run = useCallback((js: string) => {
    if (ready.current) web.current?.injectJavaScript(`${js};true;`);
    else queue.current.push(js);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      reset: (cols, rows, data) => {
        // Un reset descarta lo que estaba por escribirse con el tamaño anterior.
        queue.current = [];
        run(`window.cc.reset(${cols}, ${rows}, ${JSON.stringify(data)})`);
      },
      write: (data) => run(`window.cc.write(${JSON.stringify(data)})`),
      resize: (cols, rows) => run(`window.cc.resize(${cols}, ${rows})`),
    }),
    [run],
  );

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    if (e.nativeEvent.data !== "ready") return;
    ready.current = true;
    const pending = queue.current;
    queue.current = [];
    for (const js of pending) web.current?.injectJavaScript(`${js};true;`);
  }, []);

  const source = useMemo(() => ({ html: PAGE }), []);

  return (
    <WebView
      ref={web}
      source={source}
      originWhitelist={["*"]}
      onMessage={onMessage}
      style={styles.web}
      javaScriptEnabled
      // Nada de navegar a otro lado (un link impreso en la terminal): la página es solo la
      // terminal. La carga inicial es `about:blank` o `data:` según la plataforma.
      onShouldStartLoadWithRequest={(req) => !/^https?:/i.test(req.url)}
      setSupportMultipleWindows={false}
      scalesPageToFit
      bounces={false}
      automaticallyAdjustContentInsets={false}
    />
  );
});

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: colors.bg },
});
