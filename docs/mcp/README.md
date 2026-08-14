# Radarist MCP

Radarist exposes a local Model Context Protocol endpoint so an authenticated
client can inspect and invoke retained application tools.

## v0.1 boundary

The MCP surface is for loopback evaluation with test data. Do not expose it
through a tunnel, reverse proxy, public bind, or hosted deployment. An MCP key
does not reveal provider credentials, but it can authorize reads, mutations,
tool calls, and provider spend within its granted permissions.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `/api/mcp` | aggregate JSON-RPC MCP endpoint |
| `/api/mcp/[server]` | domain-specific dispatch |
| `/api/mcp/keys` | authenticated key lifecycle |
| `/api/mcp/tools-status` | authenticated tool/server status |

Use `tools/list` at runtime rather than relying on a hand-maintained tool list.
The generated [Capabilities](../CAPABILITIES.md) document summarizes the
retained public surface.

## Authentication and permissions

Create an MCP key from **Settings -> MCP Servers -> MCP API Keys**. The full key
is displayed only when created. Store it outside the repository and revoke it
when the client is no longer used.

Permissions are scoped to categories such as `read`, `write`, `delete`, and
`signals`. Request the smallest set a client needs. Tool discovery and dispatch
are permission-filtered server-side, but this does not make an untrusted client
safe.

## Connect a client

See [MCP client setup](CLIENT-SETUP.md) for the bundled local stdio bridge and
the native HTTP shape. Keep the Radarist app running at
`http://127.0.0.1:9002` while using either option.

## AI boundary

Some tools require optional model or research provider settings. Calling such a
tool can transmit prompt/source content and incur charges. Build-mission tools
and their sandbox are experimental, default-off, and not qualified or supported
in v0.1.

See [Security](../../SECURITY.md), [Environment](../ENVIRONMENT.md), and
[Limitations](../LIMITATIONS.md).
