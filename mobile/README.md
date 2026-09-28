# Control Code — app móvil

Manejá los agentes de tu computadora desde el teléfono:

- **Ver las tabs en vivo** — la terminal de cada agente, con el mismo tamaño que en el PC.
- **Escribirles** — texto (se manda con Enter, como lo haría una persona) y teclas sueltas
  para los menús de una TUI: Esc, Ctrl-C, Tab, flechas, 1/2/3.
- **Abrir agentes** — elegís el agente, la carpeta y, si querés, el primer pedido.
- **Aprobar permisos y contestar preguntas** — lo que la flota espera de vos y las
  preguntas de `ask_user`, con Permitir / Denegar / Permitir siempre.
- **Notificaciones** cuando un agente te necesita y la app está cerrada.

React Native + Expo (SDK 57), con Expo Router.

## Cómo se conecta

```
Control Code (PC) ──► relay (auto-alojado, ../relay) ◄── esta app
```

Nadie abre puertos: el PC y el teléfono se conectan hacia afuera al relay. Todo lo que
pasa entre ellos va cifrado de punta a punta (NaCl `crypto_box`, con `tweetnacl` acá y
`crypto_box` en Rust); el relay solo lo reenvía. La clave del teléfono vive en el
almacenamiento seguro del sistema (Keychain / Keystore). Protocolo completo:
[`docs/remote-protocol.md`](../docs/remote-protocol.md).

## Ponerlo en marcha

1. **El relay**: ver [`relay/README.md`](../relay/README.md) (Docker Compose con TLS).
2. **Control Code**: Configuración → Móvil → dirección del relay (`wss://…`), token, y
   activar.
3. **La app** en el teléfono (abajo), y en Control Code «Emparejar un teléfono»: escaneás
   el QR y listo. El código vence a los 5 minutos y sirve una sola vez.

## Compilar la app

Usa módulos nativos (cámara, notificaciones, WebView), así que no corre en Expo Go: hace
falta un build propio.

```sh
bun install                 # genera también la terminal embebida (postinstall)

# En la nube, sin Xcode ni Android Studio:
bunx eas-cli init           # crea el proyecto de EAS (necesario para las notificaciones)
bunx eas-cli build --profile preview --platform android   # un .apk para instalar directo
bunx eas-cli build --profile preview --platform ios       # iOS: requiere cuenta de Apple

# O local, con Android Studio / Xcode instalados:
bun run android
bun run ios
```

Sin `eas init` la app funciona igual, pero sin notificaciones: el token de push de Expo
necesita el `projectId` del proyecto.

## Desarrollo

```sh
bun run typecheck
bun run lint
bun test
```

Los tests de `src/protocol` corren contra el relay de verdad y contra un PC mínimo escrito
en Rust (`relay/examples/echo_desktop.rs`), para probar que los dos lados se entienden;
se saltean si esos binarios no están compilados:

```sh
cd ../relay && cargo build --release && cargo build --release --example echo_desktop
```

## Estructura

```
src/
  app/          pantallas (Expo Router): computadoras, emparejar, un PC, una tab, nuevo agente
  components/   UI, tarjetas de permisos y preguntas, la terminal (xterm.js en una WebView)
  lib/          conexión con cada PC, almacenamiento seguro, notificaciones, emparejar
  protocol/     el protocolo sin React Native: base64url, cifrado, mensajes, cliente del relay
scripts/
  embed-xterm.mjs   mete xterm.js dentro del bundle (la terminal no depende de un CDN)
```
