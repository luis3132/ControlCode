# Relay de Control Code. Se construye desde la carpeta relay/:
#   docker build -t controlcode-relay relay/
# bookworm, igual que la imagen final (debian12): mismo glibc.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

# Sin shell ni paquetes: solo el binario.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/controlcode-relay /usr/local/bin/controlcode-relay
ENV CC_RELAY_ADDR=0.0.0.0:8787
EXPOSE 8787
USER nonroot
ENTRYPOINT ["/usr/local/bin/controlcode-relay"]
