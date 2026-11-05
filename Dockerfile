FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code @notionhq/notion-mcp-server \
  # Bind-mounted Windows folders show a different owner, which git would otherwise refuse.
  && git config --system --add safe.directory '*'
WORKDIR /app
COPY server.js lib.js prompt.md mcp.json ./
# bypassPermissions refuses to run as root.
USER node
CMD ["node", "server.js"]
