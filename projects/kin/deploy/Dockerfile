# Kin test server image (deploy/README.md). Build from projects/kin:
#   docker compose -f deploy/compose.yaml build
#
# Stage 1 builds the Rust domain engine to WebAssembly with the toolchain
# pinned in rust-toolchain.toml, so the server never needs Rust installed.
FROM rust:1.93.0-slim AS wasm
WORKDIR /kin
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY rust ./rust
RUN cargo build --target wasm32-unknown-unknown --release

# Stage 2 is the Node service. Kin has no npm runtime dependencies, so there
# is no install step: the server and the static web app are copied as-is.
FROM node:24.22.0-slim
ENV NODE_ENV=production \
    KIN_HOST=127.0.0.1 \
    KIN_PORT=8000 \
    KIN_DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY --from=wasm /kin/target/wasm32-unknown-unknown/release/kin.wasm ./web/wasm/kin_engine.wasm
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# Kin listens on loopback only (it refuses anything else). Caddy shares this
# container's network namespace (compose.yaml) and is the only way in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# start.mjs runs the service inside Node's permission model (server/permissions.mjs).
CMD ["node", "server/start.mjs"]
