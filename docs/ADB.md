# Android en Control Code: ver y usar un dispositivo, la persona y los agentes

## Contexto

Un agente que construye una app Android puede compilarla, pero hasta ahora no podía usarla.
Solo podía correr comandos de `adb` sueltos y adivinar qué pasaba en la pantalla.

La idea es la misma que con el navegador: **el dispositivo es un lugar compartido.**
- La persona ve la pantalla en vivo en un tab, y la usa con el mouse como dedo y con el teclado.
- Los agentes la usan como lo haría una persona:
  - leen la pantalla;
  - tocan, deslizan y escriben;
  - abren apps;
  - leen logcat.
- Cada toque de un agente se dibuja con su color (`agentPaint`), así se ve quién hace qué.

**Sin `adb` instalado no aparece nada:** ni el botón, ni la vista, ni las tools.

## Cómo se encuentra adb

Se busca en este orden, y lo encontrado se recuerda 20 s:
1. `ANDROID_HOME/platform-tools` y `ANDROID_SDK_ROOT/platform-tools`;
2. el `PATH`;
3. las carpetas de siempre del SDK:
   - `~/Android/Sdk` en Linux;
   - `~/Library/Android/sdk` en macOS;
   - `%LOCALAPPDATA%\Android\Sdk` en Windows.

El emulador (`emulator/emulator`) se busca en el mismo SDK, para listar y arrancar AVDs.

Abrir la app **no** levanta el daemon de adb: solo mira si el binario existe. Los
dispositivos se listan recién al abrir la vista o cuando un agente usa una tool.

## Arquitectura (fase 1, hecha)

```
Agente ─ android_* (ccode mcp) ─> android.run (IPC) ─> android::agent ─> adb
                                        │
                                        ├─ emit "android-agent" → la ventana abre la vista (sin activarla)
                                        └─ emit "android-touch" → la vista dibuja el gesto en el color del agente

Persona ─ DeviceTab ─ android_frame (PNG crudo, ~4 fps) / android_input ─> adb
```

- **Todo corre en el backend.** A diferencia del navegador, el dispositivo no vive en la
  ventana: la ventana solo se entera después, para dibujar y refrescar.
- **Pantalla:** `adb exec-out screencap -p`, un cuadro detrás del otro, mientras la vista se ve.
  - Va por IPC como bytes crudos (`tauri::ipc::Response`), sin JSON ni base64.
  - Después de cada toque se pide un cuadro enseguida.
- **Entrada:** `adb shell input` (tap, swipe, keyevent y text). Los toques de la persona van en orden, por una cola.
- **Lectura por accesibilidad:** `uiautomator dump --compressed`.
  - Se muestra una línea por elemento útil, con ref, estado y centro en píxeles del dispositivo.
  - Un contenedor tocable sin texto propio se nombra con el texto de adentro (`≈"…"`).
  - Los volcados van de a uno: uiautomator no admite dos a la vez.
- **Convivencia:**
  - Si la persona tocó el dispositivo en los últimos 4 s, el resultado de la tool se lo dice al agente, para que espere o pregunte en vez de pelearle el control.
  - Con varios dispositivos conectados, cada agente sigue con el último que usó, o con el que la persona tiene en su vista.

### Archivos

| Dónde | Qué |
|---|---|
| `src-tauri/src/android/adb.rs` | Encontrar adb y el emulador, correrlos con tope de tiempo, `devices -l`, AVDs, `screencap` |
| `src-tauri/src/android/ui.rs` | Parseo del XML de uiautomator, el snapshot en texto con refs, buscar por texto |
| `src-tauri/src/android/input.rs` | Teclas por nombre, texto partido para `input text`, scroll |
| `src-tauri/src/android/agent.rs` | Cada operación de las tools, con el estado compartido (refs, quién usa qué) |
| `src-tauri/src/android/commands.rs` | Comandos de la vista: `android_status`, `android_frame`, `android_input`, `android_select`, `android_start_avd` |
| `src-tauri/src/ipc/commands/android.rs` | `android.run`: elige la ventana y emite los eventos |
| `src-tauri/src/ipc/mcp.rs` | La tabla `ANDROID_TOOLS`, solo listada si hay adb, y el párrafo de las instrucciones |
| `src/features/android/` | `DeviceTab.tsx` (la vista), `store.ts` (estado y eventos), `geometry.ts` y `keys.ts` (puros, con tests) |

## Tools MCP

| Tool | Qué hace | Aprobación |
|---|---|---|
| `android_devices` | Dispositivos y emuladores conectados, y AVDs que se pueden arrancar | sola |
| `android_emulator` | Arranca un AVD y espera a que termine de bootear (hasta 150 s) | pide |
| `android_snapshot` | La pantalla por accesibilidad, con refs `a1`, `a2`… | sola |
| `android_screenshot` | La imagen, reducida a 1280 px y en JPEG, con el factor para pasar a píxeles del dispositivo | sola |
| `android_tap` | Por ref, por texto o por coordenadas. `hold_ms` es un toque largo y `double` un doble toque | sola |
| `android_swipe` | `direction` para desplazar; `from_*`/`to_*` para arrastrar exacto | sola |
| `android_type` | Escribe, tocando antes el campo si se dice cuál. Acepta `clear` y `submit` | sola |
| `android_key` | back, home, recents, enter, volumen, power… varias separadas por coma | sola |
| `android_app` | launch, stop, open_url (web o deep link), list, current | sola |
| `android_install` | Instalar un APK, desinstalar, borrar datos | pide |
| `android_wait` | Que aparezca o desaparezca un texto, o que la pantalla deje de cambiar | sola |
| `android_logcat` | Últimas líneas, por paquete, nivel o regex. `clear` lo vacía | sola |
| `android_shell` | `adb shell` libre | pide |

## La vista "Dispositivo"

- Es un view tab nuevo (`kind: "android"`), **uno por workspace**: lo comparten la persona y sus agentes.
- Se abre:
  - con el ícono de teléfono de la barra, que solo aparece si hay adb;
  - sola, sin activarse, la primera vez que un agente usa el dispositivo.
- **Barra:**
  - selector de dispositivo;
  - atrás, inicio y recientes;
  - volumen y encendido;
  - buscar dispositivos.
- **Pantalla:**
  - el click es un toque y mantener es un toque largo;
  - arrastrar es deslizar, y la rueda desplaza;
  - el click derecho y Esc son "atrás";
  - el teclado escribe, juntando las letras en tandas de 140 ms, y pegar también escribe.
- **Sin dispositivo:** muestra cómo conectar uno, y los AVDs con un botón para arrancarlos.
- **Mientras actúa un agente:**
  - la pantalla lleva un borde de su color y un cartel "X está usando el dispositivo";
  - sus toques y deslizamientos se dibujan y se desvanecen;
  - las teclas y el texto aparecen como una etiqueta abajo.

## Limitaciones conocidas de la fase 1

- **Solo ASCII al escribir.** `input text` de Android rechaza acentos, ñ y emojis (verificado
  en Android 16: tira `NullPointerException`). Se dejan afuera y se avisa cuáles, al agente y
  a la persona.
- **~4 cuadros por segundo.** `screencap` codifica PNG en el teléfono; en uno real puede tardar
  300–600 ms por cuadro. Sirve para seguir lo que pasa, no para ver una animación.
- **`input` por shell es lento** (~100 ms por gesto) y no hace multitouch (pellizcar, rotar).
- **uiautomator tarda 1–3 s** y falla con animaciones continuas ("could not get idle state").
  En ese caso se avisa que se use `android_screenshot`.

## Fase 2: scrcpy

Resuelve las cuatro limitaciones de arriba con una sola pieza.

- `scrcpy-server` es un `.jar` de ~90 KB, con licencia Apache 2.0.
  - La app lo sube al teléfono (`adb push`) y lo lanza con `app_process`.
  - Abre dos sockets por `adb forward`: video H.264 y control.
- **Video:** latencia de ~50 ms y 30–60 fps, decodificado en la vista.
  - Con WebCodecs (`VideoDecoder`) donde exista.
  - Hay que **verificar que WebKitGTK lo tenga**. Si no, se usa un decodificador WASM (por ejemplo, el de `ya-webadb`) o se decodifica en Rust y se mandan cuadros.
- **Control:** mensajes binarios para toques, con multitouch y presión, teclas y **portapapeles**.
  - Escribir texto con acentos se hace con "poner en el portapapeles + pegar", que es como lo resuelve scrcpy.
- **Fallback:** si el server no arranca (un teléfono muy viejo), se sigue con la fase 1.
- **Licencia:** el `.jar` se incluye en el bundle con su aviso de copyright.

## Fase 3: pulido

- **Nodo de canvas** `android`, como el del navegador: la misma vista dentro de una página.
- Rotar la pantalla desde la barra (`settings put system user_rotation`).
- Grabar un video corto de lo que hizo el agente (`screenrecord`) para adjuntarlo a un PR.
- Wi-Fi debugging: `adb pair` / `adb connect` desde la vista.
- Un setting con la ruta de adb, para SDKs en lugares raros.
- Más adelante, que esto sea la primera extensión oficial (ver `docs/extensiones.md`).

## Verificación

- **Rust:**
  - tests de parseo (`devices -l`, AVDs, PNG, uiautomator), del snapshot con refs y sangría, de buscar por texto, de teclas, de texto y comillas, de scroll y de la traducción de la entrada de la vista;
  - tests de las aprobaciones de las tools.
- **Contra un emulador real** (`cargo test android::test::en_un_dispositivo -- --ignored --nocapture`), que recorre:
  - devices, wakeup y home;
  - una captura;
  - abrir Ajustes y esperar a que se asiente;
  - snapshot y `current`;
  - scroll;
  - tocar por ref, escribir y buscar;
  - un toque largo por texto;
  - logcat y cerrar la app.
- **Vitest:** geometría (encajar la pantalla, punto a píxel del dispositivo, toque, toque largo o deslizamiento, rueda) y teclado.
- **Pendiente de probar a mano con la app** (`bun tauri dev` y un teléfono o emulador):
  - la vista, los gestos con el mouse;
  - que se abra sola cuando un agente usa el dispositivo;
  - los colores con dos agentes a la vez.
