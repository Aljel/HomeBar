# syntax=docker/dockerfile:1.7
# HomeBar — single image: React frontend built by Node, served by the Rust (axum) backend.

########## 1. Frontend build ##########
FROM node:24-alpine AS web
WORKDIR /web
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml* frontend/package-lock.json* ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/root/.npm \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else npm ci; fi
COPY frontend/ ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm run build; else npm run build; fi

########## 2. Backend build ##########
FROM rust:1.99-slim-trixie AS api
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Cache dependencies: build a dummy main first
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src target/release/deps/*homebar* target/release/.fingerprint/homebar-*
COPY backend/ ./
RUN cargo build --release --locked

########## 3. Runtime ##########
FROM debian:trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 homebar && useradd -u 10001 -g homebar -M -s /usr/sbin/nologin homebar \
 && mkdir -p /data && chown homebar:homebar /data
WORKDIR /app
COPY --from=api /src/target/release/homebar /app/homebar
COPY --from=web /web/dist /app/static
ENV PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/static \
    RUST_LOG=info
USER homebar
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/app/homebar", "healthcheck"]
ENTRYPOINT ["/app/homebar"]
