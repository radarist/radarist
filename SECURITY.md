# Security

Radarist `0.1.0` is a local-first prototype release.

| Version | Supported |
| --- | --- |
| `0.1.0` | yes (prototype fixes only) |
| older snapshots | no |

## Intended security boundary

Run Radarist on a trusted machine and keep its services bound to loopback. The
v0.1 repository is not a production deployment template and has not been
qualified for an untrusted network, multi-tenant use, or sensitive data.

- never commit `.env.local`, `.env.docker`, MCP configuration, API keys, or
  provider credentials;
- use demo data while evaluating the prototype;
- keep Firebase emulators, Neo4j, Inngest, and the web app on `127.0.0.1`;
- review provider permissions and cost limits before enabling AI features;
- treat exported reports and support bundles as potentially sensitive;
- do not enable experimental build missions for sensitive or reproducible work.

See [Limitations](docs/LIMITATIONS.md) for the complete release boundary.

## Reporting a vulnerability

Do not report a vulnerability through a public issue. Use GitHub's private
**Report a vulnerability** flow in the repository Security tab. If that flow is
unavailable, email **security@radarist.ai**.

Include the affected version, safe reproduction steps, and impact. Do not send
working credentials, personal data, exploit data from a third party, or
customer material. No response or remediation SLA is promised for this
prototype.

## Disclosure scope

The strongest reports demonstrate an issue in the current public snapshot and
stay within local test data. Do not probe systems, accounts, or data you do not
own or have explicit permission to test.
