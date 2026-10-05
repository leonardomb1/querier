# Querier, packaged: the app, Firecracker, and the microVM a notebook runs in.
#   docker build -t querier .
#   docker compose up        (see compose.yaml for the devices and capabilities it needs)

ARG BASALT_VERSION=v0.8.17
ARG FIRECRACKER_VERSION=v1.17.0
ARG GUEST_KERNEL=firecracker-ci/v1.15/x86_64/vmlinux-6.1.155

# --- the guest: what a notebook's VM runs ----------------------------------------
FROM python:3.13-slim-bookworm AS guest
ARG BASALT_VERSION
RUN pip install --no-cache-dir --root-user-action=ignore \
      polars==1.44.2 altair==6.3.0 great_tables==1.0.0 matplotlib==3.11.2 \
 && find /usr/local/lib/python3.13 -name __pycache__ -prune -exec rm -rf {} + \
 && rm -rf /usr/share/doc /usr/share/man /var/cache/apt /var/lib/apt/lists
ADD --chmod=755 https://github.com/leonardomb1/basalt/releases/download/${BASALT_VERSION}/basalt-x86_64-linux /usr/local/bin/basalt
ADD https://github.com/leonardomb1/basalt/releases/download/${BASALT_VERSION}/basalt-x86_64-linux.sha256 /tmp/basalt.sha256
RUN cd /usr/local/bin && echo "$(cut -d' ' -f1 /tmp/basalt.sha256)  basalt" | sha256sum -c - && rm /tmp/basalt.sha256 \
 && basalt version
COPY kernel/kernel.py kernel/sqlrefs.py /opt/querier/
COPY --chmod=755 kernel/init.py /sbin/querier-init
# mount points the init uses on the read-only root
RUN mkdir -p /notebook /mnt/notebook-ro /mnt/env-ws /mnt/env-nb && python3 -m compileall -q /opt/querier /usr/local/lib/python3.13

# the root disk, made from the guest's files (read-only in the VM)
FROM debian:bookworm-slim AS guest-disk
ARG GUEST_KERNEL
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=guest / /rootfs
# Docker builds images without /etc/hosts (it injects one at run time); the VM needs it
RUN rm -rf /rootfs/proc/* /rootfs/sys/* /rootfs/dev/* /rootfs/tmp/* /rootfs/run/* \
 && printf '127.0.0.1 localhost\n' > /rootfs/etc/hosts \
 && size=$(( $(du -sm /rootfs | cut -f1) * 12 / 10 + 64 )) \
 && mkfs.ext4 -q -L querier-root -d /rootfs /rootfs.ext4 ${size}M \
 && curl -fsSL -o /vmlinux "https://s3.amazonaws.com/spec.ccfc.min/${GUEST_KERNEL}"

# --- the web UI ----------------------------------------------------------------
FROM oven/bun:1-debian AS web
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web web
COPY shared shared
RUN bun run build

# --- the app: Bun, Firecracker, and the VM's kernel and disk ----------------------
FROM oven/bun:1-debian AS app
ARG FIRECRACKER_VERSION
ARG BASALT_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      e2fsprogs iproute2 nftables git openssh-client ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-x86_64.tgz" | tar -xz -C /tmp \
 && install -m 755 /tmp/release-${FIRECRACKER_VERSION}-x86_64/firecracker-${FIRECRACKER_VERSION}-x86_64 /usr/local/bin/firecracker \
 && rm -rf /tmp/release-* \
 && firecracker --version | head -1 \
 && useradd --system --no-create-home --shell /usr/sbin/nologin fc
COPY --from=guest-disk /rootfs.ext4 /vmlinux /opt/querier/vm/
# workspaces' Python environments are locked and installed on the server (never in a sandbox)
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /usr/local/bin/uv
# for AI clients (MCP): `basalt check` validates SQL on the server, and the
# language reference of the same release answers basalt_reference
COPY --from=guest /usr/local/bin/basalt /usr/local/bin/basalt
ADD https://raw.githubusercontent.com/leonardomb1/basalt/${BASALT_VERSION}/language.md /opt/querier/basalt-language.md
WORKDIR /opt/querier
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server server
COPY shared shared
COPY kernel kernel
COPY --from=web /src/web/dist web/dist
# report templates are bundled on the server with the runtime they import as
# "querier" (server/template.ts), from these sources
COPY web/src web/src
COPY LICENSE NOTICE ./
ENV QUERIER_RUNNER=firecracker \
    QUERIER_PYTHON=/usr/bin/python3 \
    QUERIER_NOTEBOOKS=/data/notebooks \
    QUERIER_CONFIG_DIR=/data/config \
    QUERIER_ENVS=/data/envs \
    PORT=3000
EXPOSE 3000
VOLUME ["/data"]
CMD ["bun", "server/app.ts"]
