#!/usr/bin/env node
/**
 * @file mcp-stdio-bridge.mjs
 * @description Minimal MCP stdio→HTTP bridge for clients that only speak
 * stdio (Claude Desktop's local MCP config). Forwards newline-delimited
 * JSON-RPC messages from stdin to the Radarist MCP endpoint and writes
 * responses back to stdout. Zero dependencies — plain Node 18+.
 *
 * Claude Desktop config (Settings → Developer → Edit Config):
 * {
 *   "mcpServers": {
 *     "radarist": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/studio/scripts/mcp-stdio-bridge.mjs"],
 *       "env": {
 *         "RADARIST_API_KEY": "tp_live_…",
 *         "RADARIST_API_URL": "http://127.0.0.1:9002/api/mcp"
 *       }
 *     }
 *   }
 * }
 *
 * Generate keys in Settings → MCP Servers → MCP API Keys.
 */

const API_URL = process.env.RADARIST_API_URL || 'http://127.0.0.1:9002/api/mcp';
const API_KEY = process.env.RADARIST_API_KEY || '';

if (!API_KEY) {
  process.stderr.write('[radarist-bridge] RADARIST_API_KEY is not set — generate one in Settings → MCP Servers.\n');
}

process.stderr.write(`[radarist-bridge] forwarding stdio ⇄ ${API_URL}\n`);

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      forward(line);
    }
  }
});

process.stdin.on('end', () => process.exit(0));

async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`[radarist-bridge] dropping non-JSON line: ${line.slice(0, 120)}\n`);
    return;
  }
  const isNotification = message.id === undefined || message.id === null;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    // Notifications get no response on stdio (the server may reply 202/empty).
    if (isNotification) return;
    if (!text.trim()) {
      reply({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: `Empty response (HTTP ${res.status})` },
      });
      return;
    }
    try {
      reply(JSON.parse(text));
    } catch {
      reply({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: `Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}` },
      });
    }
  } catch (err) {
    process.stderr.write(`[radarist-bridge] request failed: ${err?.message || err}\n`);
    if (!isNotification) {
      reply({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: `Radarist unreachable at ${API_URL} — is the dev server running? (${err?.message || err})`,
        },
      });
    }
  }
}

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
