# ── Stage 1: build razor-runner for linux-x64 ─────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dotnet-build

WORKDIR /src
COPY razor-runner/ ./

RUN dotnet publish -c Release \
      -r linux-x64 \
      --self-contained true \
      -p:PublishSingleFile=false \
      -o /out

# ── Stage 2: Node app with the Linux razor-runner binary ──────────────────────
FROM node:20-slim

# .NET self-contained binaries need libssl and libicu at runtime.
# node:20-slim (Debian Bookworm) strips these out — install them explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libssl3 \
      libicu72 \
    && rm -rf /var/lib/apt/lists/*

# Invariant globalization mode — avoids needing full ICU data
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

# Run as non-root for security
RUN groupadd -r razorgen && useradd -r -g razorgen razorgen

WORKDIR /app

# App files
COPY server.js index.html ./

# Seed patterns file (will be overridden by volume mount in production)
COPY patterns.json ./

# razor-runner binary from build stage
RUN mkdir -p razor-runner-dist
COPY --from=dotnet-build /out/razor-runner ./razor-runner-dist/razor-runner
RUN chmod +x ./razor-runner-dist/razor-runner

RUN chown -R razorgen:razorgen /app

USER razorgen

EXPOSE 43000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:43000/login || exit 1

CMD ["node", "server.js"]
