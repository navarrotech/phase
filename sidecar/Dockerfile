# Pinned to the exact Node the sidecar is developed against — a floating tag here
# would silently move the runtime under a credential-handling process.
FROM node:22.22.2-bookworm-slim

WORKDIR /app

# Dependencies first so an edit to src/ does not re-resolve the tree. The Claude
# Code CLI ships inside @anthropic-ai/claude-agent-sdk, so this layer is also
# what puts the CLI in the image — there is nothing else to install.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

# The CLI writes session transcripts and refreshed credentials under its config
# directory. Default it somewhere writable so a run with no mounted ~/.claude
# still works; an operator reusing their own login overrides this to the real
# directory and must mount it read-WRITE (see .env.example).
ENV CLAUDE_CONFIG_DIR=/app/.claude
ENV LLM_OPPONENT_HOST=0.0.0.0
ENV LLM_OPPONENT_PORT=8788

EXPOSE 8788

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/api/v1/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
