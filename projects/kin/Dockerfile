# Kin on Railway (deploy/railway/README.md): one container, because Railway
# sends traffic to a public port and Kin listens on loopback only. A small
# Caddy inside the container takes Railway's traffic on $PORT and passes it
# to Kin on 127.0.0.1:8000. Railway's edge terminates HTTPS.
#
# It lives at the project root so Railway finds it automatically once the
# service's Root Directory is projects/kin; no Dockerfile path setting is
# needed. Attach a volume at /data. (deploy/Dockerfile is the separate image
# for running Kin on your own server with deploy/compose.yaml.)
FROM rust:1.93.0-slim AS wasm
WORKDIR /kin
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY rust ./rust
RUN cargo build --target wasm32-unknown-unknown --release

# Caddy's official binary is static, so it runs on the Debian-based Node image.
FROM caddy:2.10.2-alpine AS caddy

FROM node:24.22.0-slim
ENV NODE_ENV=production \
    KIN_HOST=127.0.0.1 \
    KIN_PORT=8000 \
    KIN_DATA_DIR=/data \
    KIN_TRUSTED_PROXIES=127.0.0.1,::1 \
    KIN_MAX_HOUSEHOLDS=10 \
    XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data
WORKDIR /app
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY package.json ./
COPY server ./server
COPY web ./web
COPY --from=wasm /kin/target/wasm32-unknown-unknown/release/kin.wasm ./web/wasm/kin_engine.wasm
COPY deploy/railway/Caddyfile /app/Caddyfile
COPY deploy/railway/start.sh deploy/railway/snapshot.mjs /app/
RUN chmod 0755 /app/start.sh && mkdir -p /data
# Starts as root only to give the node user the mounted volume, then runs
# Kin and Caddy as node (start.sh).
CMD ["/app/start.sh"]
