# Control remoto: el protocolo

Tres piezas:

```
Control Code (PC) ──WebSocket──► relay (auto-alojado) ◄──WebSocket── app móvil
```

- **Control Code** se conecta **hacia afuera** al relay: no hay que abrir puertos en la casa.
- **El relay** (`relay/`) autentica a cada conexión por su clave pública y reenvía mensajes
  entre ellas. **No puede leerlos**: todo lo que pasa entre el PC y el móvil va cifrado de
  punta a punta. Tampoco guarda nada en disco.
- **La app móvil** (`mobile/`) se empareja con un PC escaneando un QR.

Todo el texto es JSON en frames de texto de WebSocket. Los binarios van en **base64url sin
padding** (`b64`).

## Claves e identidades

Cada parte tiene un par de claves **X25519** (NaCl `box`). La identidad de una parte es su
clave pública en b64 (43 caracteres). El cifrado es `crypto_box` de NaCl
(X25519 + XSalsa20-Poly1305): `crypto_box` en Rust, `tweetnacl` en TypeScript. Los dos
producen exactamente los mismos bytes (hay vectores en `relay/tests/vectors.json`, que
prueban las dos implementaciones).

`seal(msg, peer_pk, my_sk)` = `nonce(24 bytes aleatorios) ‖ box(msg, nonce, peer_pk, my_sk)`.

## 1. Relay: conectarse

`GET /v1/ws` (upgrade a WebSocket). `GET /health` devuelve `ok`.

```
relay → { "t": "challenge", "relay": b64(pk efímera del relay), "challenge": b64(32 bytes) }
cliente → { "t": "hello", "role": "desktop" | "device", "key": b64(mi pk),
            "proof": b64(seal(challenge, relay, mi sk)), "token": "…"? }
relay → { "t": "ready", "id": b64(mi pk) }
      | { "t": "error", "code": "auth" | "token" | "proto", "message": "…" }  (y cierra)
```

`proof` demuestra que el cliente tiene la clave secreta de la pública que dice: solo con
ella se puede armar una caja que el relay abra con `(su sk, key)`. `token` es obligatorio
si el relay se levantó con `CC_RELAY_TOKEN`.

## 2. Relay: mensajes

```
cliente → { "t": "send", "to": id, "body": b64 }
relay   → { "t": "msg", "from": id, "body": b64 }              (a TODAS las conexiones de `to`)
relay   → { "t": "undelivered", "to": id }                     (si `to` no está conectado)

cliente → { "t": "watch", "ids": [id, …] }                     (reemplaza la lista anterior)
relay   → { "t": "presence", "id": id, "online": bool }        (al pedirlo, y en cada cambio)

relay   → { "t": "error", "code": "rate" | "size" | "proto", "message": "…" }
```

El relay no encola: si el destinatario no está, avisa `undelivered` y descarta. Límites:
256 KiB por frame, 400 mensajes por 10 s por conexión, 16 conexiones por identidad.
Manda ping de WebSocket cada 30 s.

## 3. De punta a punta (dentro de `body`)

`body = seal(json, peer_pk, my_sk)`. El JSON de adentro es uno de:

```
pedido    { "k": "req", "id": uuid, "ts": ms, "m": "método", "p": { … } }
respuesta { "k": "res", "id": uuid-del-pedido, "ts": ms, "ok": true, "r": … }
          { "k": "res", "id": …, "ts": ms, "ok": false, "e": "mensaje" }
evento    { "k": "evt", "id": uuid, "ts": ms, "e": "nombre", "d": { … } }
```

Contra la **repetición** (el relay podría reenviar un "aprobar" viejo): quien recibe descarta
lo que tenga `ts` a más de 5 minutos del reloj propio y los `id` ya vistos en los últimos 10.

Control Code **descarta todo lo que venga de una clave que no esté emparejada**, salvo el
pedido `pair`.

### Emparejar

El PC muestra un QR con:

```json
{ "v": 1, "relay": "wss://relay.ejemplo.com", "token": "…"?, "desktop": b64(pk del PC),
  "name": "PC de Luis", "secret": b64(32 bytes) }
```

El móvil se conecta al relay y manda al PC:

```
req pair { "secret": …, "name": "iPhone de Luis", "platform": "ios", "pushToken": "…"? }
→ res { "name": "PC de Luis" }
```

El secreto es de un solo uso y vence a los 5 minutos. El QR le da al móvil la clave del PC
por un canal que el relay no ve (así el relay no puede hacerse pasar por el PC), y el
secreto prueba ante el PC que quien escribe es quien escaneó el QR.

### Métodos (móvil → PC)

| Método | Parámetros | Respuesta |
|---|---|---|
| `state` | — | `{ name, version, tabs: Tab[], approvals: Approval[], asks: Ask[] }` |
| `tab.attach` | `tabId` | `{ scrollback, running, cols, rows }` y después eventos `tab.data` |
| `tab.detach` | `tabId` | `{}` |
| `tab.send` | `tabId, text, enter?` (default `true`) | `{}` — escribe y confirma, como `ccode tab send` |
| `tab.keys` | `tabId, data` | `{}` — bytes crudos (Ctrl-C = `\u0003`, Esc = `\u001b`, flechas…) |
| `tab.create` | `cwd, agent, prompt?` | `{ tabId }` |
| `launch.options` | — | `{ agents: [{id,label}], folders: string[] }` |
| `approval.decide` | `id, allow, remember?` | `{ decided: bool }` |
| `ask.answer` | `id, answer` | `{ answered: bool }` |
| `push.register` | `token` | `{}` |
| `unpair` | — | `{}` — el PC olvida este dispositivo |

`Tab = { id, title, agentId, agentLabel, cwd, running }`

`Approval = { id, taskId, toolName, input, askedAt, suggestedRule? }` — un agente de la flota
esperando permiso.

`Ask = { id, question, options: string[], placeholder?, taskId?, tabId?, cwd? }` — un agente
preguntando algo (`ask_user`).

### Eventos (PC → móvil)

| Evento | Datos |
|---|---|
| `tab.data` | `{ tabId, data }` — salida nueva de una tab a la que el móvil está enganchado |
| `tab.exit` | `{ tabId, code }` |
| `tab.resize` | `{ tabId, cols, rows }` — la terminal del PC cambió de tamaño |
| `approvals` | `{ list: Approval[] }` — cada vez que cambia la cola |
| `asks` | `{ list: Ask[] }` — cada vez que cambia |

### Notificaciones push

El PC sabe por `presence` si el móvil está conectado. Si no lo está y aparece un permiso o
una pregunta, le manda una notificación por el servicio de Expo
(`https://exp.host/--/api/v2/push/send`) al token que el móvil registró. El texto es
genérico ("Un agente espera tu permiso"): el contenido real solo viaja cifrado por el relay.
