/**
 * El nombre de la tecla de un evento, corregido para WebKitGTK.
 *
 * En GTK, Shift+Tab no llega como Tab: el teclado lo traduce a la tecla `ISO_Left_Tab`, y
 * WebKitGTK no la reconoce al armar el evento — trae `key: "Unidentified"`, aunque `code`
 * dice `"Tab"` y `keyCode` es 9 (ver `keyValueStringForGdkKeyval` en
 * `Source/WebKit/Shared/gtk/WebKeyboardEventGtk.cpp`). Chrome, WebView2 y WKWebView sí
 * dicen `"Tab"`. Todo lo que mira `key` para reconocer Tab (el teclado de la terminal, los
 * atajos) tiene que pasar por acá, o en Linux Shift+Tab es una tecla desconocida.
 */
export function keyName(event: { key: string; code?: string }): string {
  if (event.key === "Unidentified" && event.code === "Tab") return "Tab";
  return event.key;
}
