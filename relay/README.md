# controlcode-relay

El servidor que conecta **Control Code** (en tu PC) con su **app móvil**, para manejar tus
agentes desde el teléfono. Lo alojás vos.

- El PC y el móvil se conectan **hacia** el relay: no hay que abrir puertos en tu casa.
- Todo lo que pasa entre ellos va **cifrado de punta a punta** (NaCl `crypto_box`). El relay
  solo ve quién le escribe a quién, nunca el contenido. No guarda nada en disco.
- Cada conexión se autentica con su clave pública; con `CC_RELAY_TOKEN`, además, solo entra
  quien tenga el token.

Protocolo completo: [`docs/remote-protocol.md`](../docs/remote-protocol.md).

## Levantarlo

### Con Docker Compose (recomendado: incluye TLS)

```sh
cd relay
echo "CC_RELAY_TOKEN=$(openssl rand -hex 24)" > .env
# editá Caddyfile con tu dominio
docker compose up -d
```

La dirección para Control Code es `wss://tu-dominio`.

### El binario solo

```sh
cargo build --release
CC_RELAY_TOKEN=un-secreto-largo ./target/release/controlcode-relay --addr 0.0.0.0:8787
```

Detrás de cualquier proxy con TLS (Caddy, nginx, Traefik) que pase WebSockets a
`/v1/ws`. Sin TLS (`ws://`) funciona, pero solo tiene sentido en tu red local o por una VPN
como Tailscale: el contenido igual va cifrado, pero el token viajaría en claro.

| Variable / flag | Por defecto | |
|---|---|---|
| `CC_RELAY_ADDR` / `--addr` | `0.0.0.0:8787` | Dónde escuchar |
| `CC_RELAY_TOKEN` / `--token` | — | Si está, cada cliente tiene que presentarlo |

`GET /health` responde `ok`, para el chequeo de salud del proxy o del orquestador.

## Tests

```sh
cargo test
```

Levantan el relay en un puerto libre y lo prueban con clientes WebSocket reales. Los
vectores de cifrado (`tests/vectors.json`) los verifica también la app móvil con
`tweetnacl`.
