# ─────────────────────────────────────────────
# Stage 1: Builder — compiles C++ native module
# ─────────────────────────────────────────────
FROM node:20-bullseye-slim AS builder

# Install C++ toolchain, Python, CMake — required for node-gyp + ONNX
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
    cmake \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first — layer cache avoids reinstalling on code changes
COPY package*.json ./
COPY native/ ./native/

# Install ALL deps (including devDeps for the build tools)
# This triggers node-gyp and compiles the .node binary inside the container
RUN npm install --include=dev

# Copy everything else
COPY . .

# Download ONNX model + tokenizer, vendor tree-sitter grammars
# Scripts should be idempotent — safe to run even if files exist
RUN bash scripts/setup-onnx.sh && bash scripts/vendor-grammars.sh

# ─────────────────────────────────────────────
# Stage 2: Runtime — lean production image
# ─────────────────────────────────────────────
FROM node:20-bullseye-slim AS runtime

# Only runtime deps — no compiler needed here
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled artifacts from builder
COPY --from=builder /app/node_modules     ./node_modules
COPY --from=builder /app/native/build     ./native/build
COPY --from=builder /app/models           ./models
COPY --from=builder /app/vendor           ./vendor
COPY --from=builder /app/src              ./src
COPY --from=builder /app/package.json     ./package.json

# Persistent data directory — mount as volume in production
RUN mkdir -p /app/src/data

EXPOSE 3000

# Healthcheck — confirms the proxy is accepting connections
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/dashboard || exit 1

CMD ["node", "src/server.js"]