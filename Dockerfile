# digestseo-mcp — local stdio MCP server in a container.
#
# Build:  docker build -t digestseo-mcp .
# Run:    docker run -i --rm \
#           -e OPENAI_API_KEY=sk-... \
#           -v digestseo-data:/data -e DIGESTSEO_DB_PATH=/data/digestseo.sqlite \
#           digestseo-mcp
#
# stdio transport: keep -i (interactive stdin) and never -t (a TTY would
# corrupt the JSON-RPC stream). Without the volume mount the SQLite
# database lives inside the container and disappears with it.

FROM node:22-slim

WORKDIR /app

# Install with dev deps first — the TypeScript build needs them.
# better-sqlite3 downloads a prebuilt linux binary during npm ci, so no
# python/make/g++ toolchain is required on -slim.
COPY package.json package-lock.json ./
RUN npm ci

# Only what the Node build consumes (see tsconfig.node.json include):
# the CLI + core + sqlite sources, and migrations for the runtime.
COPY tsconfig.node.json ./
COPY src ./src
COPY migrations ./migrations

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/cli.js"]
