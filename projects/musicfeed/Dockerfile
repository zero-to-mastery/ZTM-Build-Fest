# syntax=docker/dockerfile:1

# Adapted from the Zero to Production in Rust Dockerfile, with four changes:
#   - the `-bookworm` chef tag, because the plain `latest-rust-1` image is Debian
#     trixie (glibc 2.41) while the runtime stage is bookworm (glibc 2.38), and a
#     binary built against trixie will not run on bookworm
#   - Rust 1.99 rather than 1.80.1, because edition 2024 will not compile on 1.80
#   - `cmake` alongside `clang`/`lld`, because `aws-lc-sys` (a rustls backend)
#     builds C and needs cmake; `openssl` is not needed, the TLS stack is rustls
#   - `configuration`, `static` and `templates` are copied in, because the app
#     reads all three from the working directory at startup and panics without them
FROM lukemathwalker/cargo-chef:latest-rust-1-bookworm AS chef
WORKDIR /app
RUN apt update && apt install lld clang cmake -y


FROM chef AS planner
COPY . .
# Compute a lock-like file so dependency compilation is cached independently of
# our own source. Editing src/ then does not rebuild ~300 crates.
RUN cargo chef prepare --recipe-path recipe.json


FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# Build our project dependencies, not our application!
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
# Build our project
RUN cargo build --release --bin musicfeed


FROM debian:bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ca-certificates \
    # Clean up
    && apt-get autoremove -y \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/*
# `get_configuration` reads configuration/, `AppState::new` globs templates/
# and the datastar client is served from static/. migrations/ is NOT copied:
# sqlx::migrate!("./migrations") embeds the SQL at compile time, so the
# binary carries its own schema. Consequence worth knowing — changing a
# migration requires a rebuild, not just a new file in a running image.
COPY --from=builder /app/target/release/musicfeed musicfeed
COPY configuration configuration
COPY static static
COPY templates templates
ENV APP_ENVIRONMENT=production
ENTRYPOINT ["./musicfeed"]
