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

## Arquitectura

```
Agente ─ android_* (ccode mcp) ─> android.run (IPC) ─> android::agent ─> adb
                                        │
                                        ├─ emit "android-agent" → la ventana abre la vista (sin activarla)
                                        └─ emit "android-touch" → la vista dibuja el gesto en el color del agente

Persona ─ DeviceTab ─ fetch http://127.0.0.1:<puerto>/screen ─> android::stream ─> adb exec-out screenrecord (H.264)
                   └─ android_input ─> android::pointer ─> un `adb shell` abierto (input motionevent DOWN/MOVE/UP)
```

- **Todo corre en el backend.** A diferencia del navegador, el dispositivo no vive en la
  ventana: la ventana solo se entera después, para dibujar y refrescar.
- **Pantalla: video H.264 directo de adb**, sin nada instalado en el teléfono.
  - `adb exec-out screenrecord --output-format=h264 -` manda cuadros solo cuando algo cambia, a 30–60 por segundo.
    Antes era un `screencap -p` por vez: en un Poco X3 Pro tardaba **1,1 s por cuadro**.
  - El video **no pasa por la IPC de Tauri**: un mensaje grande por un `Channel` termina en un `webview.eval` en el hilo
    principal, y a 60 por segundo volverían los congelamientos. Lo sirve un socket local (`127.0.0.1`, con un token),
    un hilo por conexión, y la vista lo lee con `fetch` y lo decodifica con **WebCodecs** (`VideoDecoder`) en un canvas.
  - `android::h264` corta el stream en cuadros. Un cuadro sale apenas se ve la cabecera del NAL siguiente; el último de
    una ráfaga, cuando el pipe queda 20 ms quieto. Reescribe el SPS con `max_num_reorder_frames = 0` (como Moonlight)
    para que el decodificador no se guarde cuadros.
  - `screenrecord` corta a los 3 minutos y no sigue la rotación: se relanza solo, y cada 1,5 s se mira `cur=` de
    `dumpsys window` para relanzarlo si la pantalla rotó. Si el encoder no acepta el tamaño, prueba con uno más chico.
  - Medido en WebKitGTK 2.54 contra el emulador: 64 de 64 cuadros, de 5 a 15 ms desde que llegan hasta que se ven.
  - **Capturas que completan:** `screenrecord` no manda nada hasta que algo cambia, así que la primera imagen es un
    `screencap`. Y con perfil High (el del Poco) el pipeline de WebKitGTK se guarda el último cuadro hasta recibir otro,
    así que cuando el video lleva 400 ms quieto se pide una captura que deja la imagen exacta.
  - **Sin WebCodecs** (WebKitGTK viejo) o si el video falla dos veces, la vista vuelve a capturas sueltas, como antes.
- **Entrada de la persona: un `adb shell` abierto por dispositivo** (`android::pointer`).
  - El dedo va en vivo: `input motionevent DOWN` al apretar, `MOVE` mientras se mueve (uno por cuadro de animación) y
    `UP` al soltar. Arrastrar se ve mientras se arrastra, y mantener es un toque largo de verdad.
  - Todo va en orden por una cola, y la vista no espera al teléfono. Los `MOVE` que esperan se juntan en el último.
  - Android sin `motionevent` (anterior a 10): el gesto se arma al soltar, como antes.
  - Los errores del teléfono llegan por el evento `android-input-error`.
- **Entrada de los agentes:** `adb shell input` por cada acción, porque necesitan saber cómo salió.
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
| `src-tauri/src/android/h264.rs` | Cortar el H.264 de `screenrecord` en cuadros, reescribir el SPS, armar el `avcC` |
| `src-tauri/src/android/stream.rs` | El servidor local del video: un `screenrecord` por vista, relanzado al rotar o a los 3 min |
| `src-tauri/src/android/pointer.rs` | El `adb shell` abierto para la entrada de la persona, con su cola |
| `src-tauri/src/android/commands.rs` | Comandos de la vista: `android_status`, `android_stream`, `android_frame`, `android_input`, `android_select`, `android_start_avd` |
| `src-tauri/src/ipc/commands/android.rs` | `android.run`: elige la ventana y emite los eventos |
| `src-tauri/src/ipc/mcp.rs` | La tabla `ANDROID_TOOLS`, solo listada si hay adb, y el párrafo de las instrucciones |
| `src/features/android/` | `DeviceTab.tsx` (la vista), `stream.ts` (video, capturas y el lector de mensajes), `store.ts` (estado y eventos), `geometry.ts` y `keys.ts` (puros, con tests) |

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
  - el mouse es el dedo, en vivo: el click es un toque, mantener es un toque largo y arrastrar arrastra;
  - la rueda desplaza;
  - el click derecho y Esc son "atrás";
  - el teclado escribe, juntando las letras en tandas de 140 ms, y pegar también escribe.
- **Sin dispositivo:** muestra cómo conectar uno, y los AVDs con un botón para arrancarlos.
- **Mientras actúa un agente:**
  - la pantalla lleva un borde de su color y un cartel "X está usando el dispositivo";
  - sus toques y deslizamientos se dibujan y se desvanecen;
  - las teclas y el texto aparecen como una etiqueta abajo.

## Xiaomi, Redmi y POCO

MIUI no deja que adb simule toques hasta activar **"Depuración USB (ajustes de seguridad)"** en Opciones de
desarrollador (pide una cuenta Mi y una SIM). Sin eso, `input` falla con `INJECT_EVENTS`. `adb::explain` lo
convierte en qué hacer: la vista lo muestra traducido y el agente recibe que se lo pida a la persona.

## Limitaciones conocidas

- **Solo ASCII al escribir.** `input text` de Android rechaza acentos, ñ y emojis (verificado en Android 16: tira
  `NullPointerException`). Se dejan afuera y se avisa cuáles, al agente y a la persona.
- **Sin multitouch** (pellizcar, rotar): `input motionevent` es un solo dedo.
- **Cada gesto lanza `cmd input` en el teléfono** (~30–60 ms). Para el dedo alcanza porque los `MOVE` se juntan.
- **Con la pantalla apagada no hay video**: `screenrecord` no recibe cuadros. La vista muestra la última captura.
- **uiautomator tarda 1–3 s** y falla con animaciones continuas ("could not get idle state"). En ese caso se avisa que
  se use `android_screenshot`.
- **`android_screenshot` sigue siendo `screencap`**: en un teléfono real tarda alrededor de un segundo.

## Lo que todavía resolvería scrcpy

El video y el dedo en vivo ya salen de adb solo. `scrcpy-server` (un `.jar` de ~90 KB, Apache 2.0, subido con
`adb push` y lanzado con `app_process`) agregaría lo que `input` no puede:
- texto con acentos y emojis, por el portapapeles;
- multitouch y presión;
- inyectar sin lanzar un proceso por gesto.

Solo vale la pena si eso hace falta: hoy no es lo que traba.

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
- **El video y el dedo** (`ANDROID_SERIAL=… cargo test android::test::en_un_dispositivo_el_video -- --ignored --nocapture`):
  abre el stream, arrastra en vivo para abrir el cajón de apps y cuenta los mensajes. `sirve_el_video_un_minuto` deja
  el servidor andando para consumirlo desde un navegador.
- **Rust:** cortar el stream en cuadros (entero o de a un byte, el último al quedar quieto, un corte mal hecho), el SPS
  reescrito (con y sin VUI), los bytes de prevención, la cola del dedo, el gesto sin `motionevent`, el pedido HTTP y el
  tamaño de la pantalla al rotar.
- **Vitest:** geometría (encajar la pantalla, punto a píxel del dispositivo, toque, toque largo o deslizamiento, rueda),
  teclado y el lector de mensajes del video (entero y partido).
- **Pendiente de probar a mano con la app** (`bun tauri dev` y un teléfono o emulador):
  - la vista, los gestos con el mouse;
  - que se abra sola cuando un agente usa el dispositivo;
  - los colores con dos agentes a la vez.
