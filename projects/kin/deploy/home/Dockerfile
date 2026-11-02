# Kin home server image (ADR 0025 §10, #715): the same single executable as
# the downloads (scripts/build-sea.mjs), on a distroless base that holds
# glibc and the C++ runtime node needs and nothing else: no shell, no package
# manager. It runs as an unprivileged user, keeps its data in the /data
# volume and checks its own health. Build from projects/kin:
#
#   docker build -f deploy/home/Dockerfile -t kin-home .
#   docker run -d --name kin --restart unless-stopped -v kin-data:/data kin-home
#
# Kin listens on loopback inside the container and opens no public
# listener: with a name set, it dials out to the connection relay and phones
# reach it through that tunnel (#733). The setup page is on the container's
# own loopback, out of the host browser's reach, so set KIN_HOME_NAME and
# KIN_HOME_ACME_TERMS_AGREED=true here; household admins then use the control
# panel at https://<name>/control/. docs/HOME-SERVER.md has the details.

# Stage 1 builds the Rust domain engine to WebAssembly with the toolchain
# pinned in rust-toolchain.toml.
FROM rust:1.93.0-slim AS wasm
WORKDIR /kin
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY rust ./rust
RUN cargo build --target wasm32-unknown-unknown --release

# Stage 2 builds the executable for this image's architecture from the
# official node binary in the node image (x64 or arm64), then unpacks its
# app files once, read-only, so the running container never writes them.
FROM node:24.22.0-slim AS build
WORKDIR /kin
COPY package.json ./
COPY server ./server
COPY web ./web
# The KTUN codec the home server's tunnel shares with the relay (#733).
COPY relay/ktun.mjs ./relay/ktun.mjs
COPY scripts/build-sea.mjs ./scripts/
COPY scripts/sea ./scripts/sea
COPY --from=wasm /kin/target/wasm32-unknown-unknown/release/kin.wasm /tmp/kin_engine.wasm
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) target=linux-x64 ;; \
      aarch64) target=linux-arm64 ;; \
      *) echo "Kin's image is built for x86_64 and aarch64 only." >&2; exit 1 ;; \
    esac; \
    node scripts/build-sea.mjs --target "$target" --node-binary "$(command -v node)" --wasm /tmp/kin_engine.wasm --out /out; \
    mkdir -p /opt/kin /image/data; \
    cp "/out/kin-$(node -p 'require("./package.json").version')-$target" /opt/kin/kin; \
    cp /out/SHA256SUMS /out/build-info.json /opt/kin/; \
    KIN_APP_CACHE=/opt/kin/app /opt/kin/kin --prepare; \
    chmod -R a+rX,go-w /opt/kin

# Stage 3 is what runs. 65532 is the distroless "nonroot" user.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /opt/kin /opt/kin
COPY --from=build --chown=65532:65532 /image/data /data
ENV KIN_MODE=home \
    KIN_DATA_DIR=/data \
    KIN_APP_CACHE=/opt/kin/app \
    KIN_HOST=127.0.0.1 \
    KIN_PORT=8000
USER 65532:65532
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["/opt/kin/kin", "--health"]
# The executable is Kin's launcher: it starts the service inside Node's
# permission model and forwards Docker's stop signal to it.
ENTRYPOINT ["/opt/kin/kin"]
