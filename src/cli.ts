#!/usr/bin/env node
// Local stdio entry for digestseo-mcp: bring-your-own-API-keys MCP
// server over stdin/stdout, backed by a local SQLite database
// (~/.digestseo/digestseo.sqlite by default, DIGESTSEO_DB_PATH to
// override). The Cloudflare Worker entry is src/index.ts; both wire
// the six shared tools from src/core/tools.ts, and the CLI adds the
// three local management tools (track_brand, list_brands,
// generate_prompts).
//
// stdout is the JSON-RPC channel — every log line in this process goes
// to stderr, never stdout.

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  getAvailableEngines,
  runEngineInProcess,
  type EngineKeys,
  type RunEnginesResult,
} from './core/engines.js';
import { registerLocalManagementTools, registerTools } from './core/tools.js';
import { defaultDbPath, openSqliteDb } from './db/sqlite.js';
import type { Brand, Prompt } from './db/types.js';
import type { EngineName } from './core/engines.js';

const ENGINE_KEY_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'PERPLEXITY_API_KEY',
  'SERPAPI_API_KEY',
] as const;

function log(message: string): void {
  process.stderr.write(`[digestseo-mcp] ${message}\n`);
}

function packageVersion(): string {
  // dist/cli.js sits one level below the package root, same as
  // src/cli.ts under the repo root when run via tsx.
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const env: EngineKeys = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    SERPAPI_API_KEY: process.env.SERPAPI_API_KEY,
  };
  // Empty strings count as unset so blank lines in client configs skip
  // the engine instead of sending an empty Authorization header.
  for (const key of ENGINE_KEY_NAMES) {
    if (env[key] !== undefined && env[key].trim().length === 0) {
      delete env[key];
    }
  }

  const available = getAvailableEngines(env);
  if (available.length === 0) {
    log(
      'no engine API keys configured; MCP discovery is available, but ' +
        'engine-backed scans require at least one of OPENAI_API_KEY, ' +
        'ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, or ' +
        'SERPAPI_API_KEY. Engines without a key are skipped gracefully.',
    );
  }

  const dbPath = defaultDbPath();
  const db = openSqliteDb(dbPath);
  const version = packageVersion();

  const server = new McpServer({ name: 'digestseo-mcp', version });
  registerTools(server, {
    db,
    env,
    // No fan-out and no subrequest budget locally: run each engine
    // inline and sequentially, then return. Progress goes to stderr.
    runEnginesInline: async (
      brand: Brand,
      prompts: Prompt[],
      engines: EngineName[],
    ): Promise<RunEnginesResult> => {
      const run_ids: Record<string, string> = {};
      for (const engine of engines) {
        const run = await db.createRun(brand, engine, 'live', prompts.length);
        run_ids[engine] = run.id;
        log(
          `refresh_brand: running ${engine} (${prompts.length} prompt${prompts.length === 1 ? '' : 's'})...`,
        );
        await runEngineInProcess({ db, ...env }, brand, prompts, {
          engine,
          run_id: run.id,
        });
        log(`refresh_brand: ${engine} finished`);
      }
      return { run_ids, engines };
    },
  });
  // Local-only brand management (track_brand, list_brands,
  // generate_prompts). The Worker keeps these behind /admin/* instead.
  registerLocalManagementTools(server, { db, env });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    `v${version} ready on stdio — engines: ${available.join(', ')}; db: ${dbPath}`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `digestseo-mcp failed to start: ${(err as Error).stack ?? String(err)}\n`,
  );
  process.exit(1);
});
