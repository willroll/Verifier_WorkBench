# Verifier Workbench — hosted, with real bounded model checkers.
#
#   docker build -t verifier-workbench .
#   docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... verifier-workbench
#
# CBMC comes from Ubuntu's archive. ESBMC ships as a release tarball.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      cbmc \
      nodejs \
    && rm -rf /var/lib/apt/lists/*

# ESBMC (optional — build still succeeds without it; the UI reports it missing)
ARG ESBMC_VERSION=7.6.1
RUN curl -fsSL -o /tmp/esbmc.tar.xz \
      "https://github.com/esbmc/esbmc/releases/download/v${ESBMC_VERSION}/esbmc-linux.tar.xz" \
      && mkdir -p /opt/esbmc \
      && tar -xJf /tmp/esbmc.tar.xz -C /opt/esbmc --strip-components=1 \
      && ln -sf "$(find /opt/esbmc -type f -name esbmc -perm -u+x | head -n1)" /usr/local/bin/esbmc \
      && rm -f /tmp/esbmc.tar.xz \
      || echo "ESBMC install skipped"

WORKDIR /app
COPY package.json server.js engines.js repair.js ./
COPY public ./public

ENV PORT=3000 VERIFY_ENGINE=cbmc
EXPOSE 3000

# Untrusted C is analysed here. Run with:
#   --network none (after startup) --read-only --tmpfs /tmp --memory 2g --pids-limit 256
CMD ["node", "server.js"]
