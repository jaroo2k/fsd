FROM node:22-slim
# Project dependencies install per run as the node user; this container is disposable.
ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    PATH=/home/node/.local/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl python3 python3-pip python3-venv fonts-noto-cjk \
  && . /etc/os-release \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && pip install pytest \
  && npm install -g @anthropic-ai/claude-code @openai/codex @notionhq/notion-mcp-server playwright \
  && playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  # Bind-mounted Windows folders show a different owner, which git would otherwise refuse.
  && git config --system --add safe.directory '*'
WORKDIR /app
COPY server.js lib.js db.js prompt.md prompt-task.md mcp.json ./
COPY assets/logo.svg ./assets/
# An empty named volume inherits this owner, so the node user can write the database. Codex writes its sessions
# next to the mounted auth.json, so its folder must belong to node too.
RUN mkdir -p /data /home/node/.codex && chown node:node /data /home/node/.codex
# bypassPermissions refuses to run as root.
USER node
CMD ["node", "server.js"]
