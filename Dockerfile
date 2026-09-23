# syntax=docker/dockerfile:1
#
# Verifier Workbench: API server + prototype UI, with CBMC, ESBMC, Z3 and cvc5.
#
#   docker build -t verifier-workbench .
#   docker run --rm -p 3000:3000 verifier-workbench
#
# This image analyses untrusted C. Checker processes get a memory cap
# (VERIFY_MEMORY_LIMIT_MB), a timeout and no server secrets, but the
# container is the real boundary. Run it with, for example:
#   --read-only --tmpfs /tmp --memory 4g --pids-limit 512 --cap-drop ALL
# and put auth in front before exposing it (docs/PLAN.md, Phase 4).

# ---- build: bundle the server and the workspace packages it imports --------
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY packages ./packages
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM ubuntu:24.04
ARG ESBMC_VERSION=8.5
ENV DEBIAN_FRONTEND=noninteractive

# CBMC 5.95.1, Z3 and cvc5 from Ubuntu; ESBMC is a static release binary with
# its solvers (Bitwuzla, Z3, cvc5, Boolector) linked in. CBMC preprocesses
# with gcc, which only *recommends* libc6-dev: without it, #include <stdint.h>
# fails, so it is installed explicitly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip cbmc libc6-dev z3 cvc5 \
 && curl -fsSL -o /tmp/esbmc.zip "https://github.com/esbmc/esbmc/releases/download/v${ESBMC_VERSION}/esbmc-linux.zip" \
 && mkdir -p /opt/esbmc \
 && unzip -q /tmp/esbmc.zip -d /opt/esbmc \
 && ln -s /opt/esbmc/release/bin/esbmc /usr/local/bin/esbmc \
 && rm /tmp/esbmc.zip \
 && apt-get purge -y curl unzip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && cbmc --version && esbmc --version && z3 --version && cvc5 --version \
 && printf '#include <stdint.h>\n#include <string.h>\nint32_t f(int32_t a) { return a; }\n' > /tmp/selftest.c \
 && cbmc /tmp/selftest.c --function f > /dev/null \
 && esbmc /tmp/selftest.c --function f > /dev/null \
 && rm /tmp/selftest.c

COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=build /src/packages/server/dist ./dist
COPY ["design/Verifier Workbench (standalone).html", "./ui/index.html"]

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin verifier
USER verifier

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    UI_HTML=/app/ui/index.html
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.mjs"]
