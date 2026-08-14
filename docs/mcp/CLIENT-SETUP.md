# MCP Client Setup

This guide connects a local MCP client to a running Radarist `0.1.0` prototype.

## Prerequisites

- Radarist is running at `http://127.0.0.1:9002`;
- you are signed in to the local application;
- the client runs on the same trusted machine;
- any optional provider key required by a selected tool is configured locally.

Do not expose the endpoint to an untrusted network.

## Create a least-privilege key

Open **Settings -> MCP Servers -> MCP API Keys** and create a key with only the
permissions the client needs. Copy the value when shown; it cannot be recovered
later. Never commit it.

You can also use the authenticated key API with a local Firebase ID token:

```bash
curl -sS \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Local MCP client","permissions":["read"],"expiresInDays":30}' \
  http://127.0.0.1:9002/api/mcp/keys
```

## Verify JSON-RPC access

```bash
curl -sS \
  -H "Authorization: Bearer $RADARIST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:9002/api/mcp
```

Use the returned list as the authority for the current key and runtime.

## Bundled stdio bridge

Clients that spawn a local stdio server can use the retained bridge:

```json
{
  "mcpServers": {
    "radarist": {
      "command": "node",
      "args": ["/absolute/path/to/radarist/scripts/mcp-stdio-bridge.mjs"],
      "env": {
        "RADARIST_API_KEY": "replace-with-local-key",
        "RADARIST_API_URL": "http://127.0.0.1:9002/api/mcp"
      }
    }
  }
}
```

Keep the configuration outside the repository and set restrictive filesystem
permissions on it.

## Native HTTP clients

For a client that supports HTTP MCP plus custom headers:

```json
{
  "mcpServers": {
    "radarist": {
      "url": "http://127.0.0.1:9002/api/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-local-key"
      }
    }
  }
}
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| unauthorized | key value, expiry, revocation, and header format |
| permission denied | requested permission versus tool requirement |
| no tools | app is running; call `tools/list`; inspect Settings status |
| tool error | required Firebase/Neo4j/Inngest/provider dependency |
| client cannot connect | loopback URL and stdio bridge absolute path |

Revoke a key after testing. Read the [MCP overview](README.md),
[Security](../../SECURITY.md), and [Limitations](../LIMITATIONS.md).
