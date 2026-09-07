#!/usr/bin/env node
/**
 * threads-mcp-server — a Model Context Protocol server for the Meta Threads API.
 *
 * Configuration:
 *   THREADS_ACCESS_TOKEN  required. A long-lived Threads user token.
 *   THREADS_USER_ID       optional. Defaults the user id on the profile tools.
 *   THREADS_BASE_URL      optional. Defaults to https://graph.threads.net/v1.0
 *   MCP_READ_ONLY=1       refuse anything that changes state.
 *   MCP_NO_DESTRUCTIVE=1  allow posting, refuse deletes.
 *
 * ⚠️  The token goes in an Authorization header, not the query string. The
 *     server this replaces put `access_token=...` in every URL, which means
 *     the credential lands in access logs, proxy logs and browser history for
 *     every request — a shape Meta's own examples encourage and which is
 *     worth not copying.
 *
 * Getting a token: the Threads app dashboard has a built-in User Token
 * Generator, which is much simpler than a full OAuth redirect flow. It only
 * works once the Threads account is set to public — otherwise it silently
 * produces nothing useful rather than saying why.
 */

import { authorizerFromEnv, requireEnv, runServer, HttpClient } from "@nasdigital/mcp-server-core";
import { buildTools } from "./tools.js";

const VERSION = "1.0.0";

async function main() {
  const token = requireEnv("THREADS_ACCESS_TOKEN");

  const http = new HttpClient({
    baseUrl: process.env.THREADS_BASE_URL || "https://graph.threads.net/v1.0",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": `threads-mcp-server/${VERSION}`,
    },
    timeoutMs: 30_000,
  });

  const tools = buildTools(http, process.env.THREADS_USER_ID);
  await runServer({
    name: "threads-mcp-server",
    version: VERSION,
    authorizer: authorizerFromEnv(),
    tools,
  });

  console.error(
    `Threads API v1.0: ${tools.length} tools. ` +
      `Meta publishes no machine-readable spec, so threads_call is the passthrough for ` +
      `anything not wrapped.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
