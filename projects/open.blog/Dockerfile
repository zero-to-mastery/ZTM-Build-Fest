# open.blog as a container: the engine plus the blog in this repository, served
# by `openblog serve --admin`. Suits Render, Fly, a VPS with Docker, or a NAS.
#
# Build:  docker build -t my-blog .
# Run:    docker run -p 8080:8080 \
#           -e OPENBLOG_ADMIN_USER=you -e OPENBLOG_ADMIN_PASSWORD='a long passphrase' \
#           -e OPENBLOG_BEHIND_PROXY=1 my-blog
#
# OPENBLOG_ADMIN_USER / OPENBLOG_ADMIN_PASSWORD create (or keep) the admin login
# at start, which matters on hosts without a persistent disk. Set
# OPENBLOG_BEHIND_PROXY=1 whenever an HTTPS proxy (Render's, Caddy, nginx) sits in
# front: it marks cookies Secure and reads the client address from X-Forwarded-For.
# Mount a volume at /blog/.openblog to keep users, analytics, and the trash.
# For SSH publishing, mount a repository deploy key and pinned GitHub known-hosts
# file, then set OPENBLOG_GIT_SSH_KEY_PATH and OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH.

FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p openblog-cli --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/openblog /usr/local/bin/openblog
WORKDIR /blog
COPY . /blog
RUN rm -rf /blog/target /blog/dist && chmod +x /blog/docker-entrypoint.sh
RUN openblog help > /dev/null
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD sh -c 'curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1'
ENTRYPOINT ["/blog/docker-entrypoint.sh"]
