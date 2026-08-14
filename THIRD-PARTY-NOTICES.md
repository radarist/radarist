# Third-Party Notices

The Radarist source code is licensed under [MIT](./LICENSE). This file
documents bundled dependencies whose licenses differ from MIT and require
explicit notice. It is not an exhaustive SBOM — the vast majority of the
dependency tree is permissively licensed (MIT / Apache-2.0 / BSD / ISC).
It calls out the **non-permissive** dependencies contributors and
self-hosters need to be aware of.

## Inter and Playfair Display webfonts — SIL Open Font License 1.1

Radarist bundles five Latin-subset WOFF2 files as data URIs inside
`public/css/report-brand.css`. The complete copyright/license header sits
outside the generated font block, so re-running the current font builder does
not erase it. Exported report HTML is a document created using the fonts; the
OFL explicitly states that such a document is not required to be licensed
under the OFL.

- **Inter 400, 600, and 800:** Copyright 2020 The Inter Project Authors
  (<https://github.com/rsms/inter>).
- **Playfair Display 700 and 800:** Copyright 2017 The Playfair Display
  Project Authors (<https://github.com/clauseggers/Playfair-Display>), with
  Reserved Font Name "Playfair Display".
- **License:** SIL Open Font License 1.1; the complete license is retained in
  [`LICENSES/SIL-OFL-1.1.txt`](./LICENSES/SIL-OFL-1.1.txt) and in a
  human-readable header in `public/css/report-brand.css`.
- **Source path:** `scripts/build-report-fonts.ts` retrieves the WOFF2 subsets
  through the Google Fonts CSS2 API and embeds the response bytes without
  modifying them. The upstream license and metadata are published in the
  Google Fonts `ofl/inter` and `ofl/playfairdisplay` directories.

Current embedded-byte receipt (SHA-256, audited 2026-07-20):

| Family / weight       | SHA-256                                                           |
| --------------------- | ----------------------------------------------------------------- |
| Inter 400             | `48a0c2503a9c8ec4153302693fff56b3281aba5ce5afd7cf2bd51a03b098cd22` |
| Inter 600             | `9a3d22c43636255dd1d3c910c534e1b55ecdcaf074ffa013971fad0d4d32f031` |
| Inter 800             | `713403e7d227a0fc231322cbd70e46601ceda4a514f08d19896a3029c2eefed9` |
| Playfair Display 700  | `02af2688dd8c8a55069e99bba3f5c70c67c8f7fb0b7fca9c4fc40c4ffc474d06` |
| Playfair Display 800  | `9d293c073e0f3b3e2e7954e531506ab6499bd273a6ae0bf7de1fa10468112ed9` |

The build script's network response is not version-pinned. Re-running it can
change these bytes; a changed receipt requires re-verifying the upstream
copyright/license metadata before committing the regenerated stylesheet.
Radarist does not rename or alter the downloaded WOFF2 bytes. Any future
modified Playfair Display build must respect its Reserved Font Name.

## Resolved: `@neo4j-nvl/*` (proprietary graph renderer) — removed 2026-07-10

The `/visualizations/graph` workbench previously depended on the **Neo4j
Visualization Library** (`@neo4j-nvl/base`, `@neo4j-nvl/react`), governed by
Neo4j's proprietary "License Agreement for Neo4j Visualization Library™" —
restricted to use with Neo4j Aura or Neo4j's commercial products, and therefore
outside permitted use against the default self-hosted **Community Edition**.

It was **replaced on 2026-07-10** with **Cytoscape.js + cytoscape-fcose** (both
MIT) in `src/components/visualizations/graph/GraphVisualization.tsx`. The
`@neo4j-nvl/*` packages are no longer in `package.json`. This also cleared the
~6 upstream-stuck `npm audit` advisories that came in through the NVL chain
(`lodash`, `js-cookie`, `@segment/analytics-next` — 4 high + 2 moderate). No
non-permissive graph-rendering dependency remains: the workbench uses
Cytoscape.js and the entity-relationship panels use the MIT
[`react-force-graph-2d`](https://github.com/vasturiano/react-force-graph).

## IEEE CSL citation style — Creative Commons Attribution-ShareAlike 3.0 (CC-BY-SA-3.0)

- **What it is:** the official IEEE Citation Style Language (CSL) style,
  vendored as a string constant rather than an npm dependency.
- **Source:** [`citation-style-language/styles`](https://github.com/citation-style-language/styles),
  file `ieee.csl`.
- **License:** [CC-BY-SA-3.0](http://creativecommons.org/licenses/by-sa/3.0/),
  per the `<rights>` element embedded in the style itself. This is a
  content/data license, not a code license, but it does carry an
  attribution + share-alike obligation distinct from the rest of the
  MIT-licensed codebase.
- **Where it is used:** `src/lib/research/ieee-csl.ts` (the vendored XML,
  inlined as `IEEE_CSL_XML` so it survives Next.js/turbopack production
  bundling without a runtime file read), consumed by
  `src/lib/research/citation.ts`'s `formatIeeeCitation` for IEEE-style
  reference formatting in research output.

## `citeproc` — CPAL-1.0 OR AGPL-1.0 (transitive)

- **Package:** `citeproc@2.4.x`, pulled in **transitively** by the direct
  dependency `@citation-js/plugin-csl` (`@citation-js/plugin-csl` → `citeproc`).
  `@citation-js/core` and `@citation-js/plugin-csl` themselves are MIT; the CSL
  processing engine underneath them is not.
- **License:** dual-licensed **`CPAL-1.0 OR AGPL-1.0`** (per its
  `package.json` `license` field). The `OR` means a downstream may **elect
  either** license and comply with only that one.
- **What this means for you:** electing **CPAL-1.0** (the Common Public
  Attribution License, a weak, file-level copyleft in the MPL family) is the
  practical choice for a closed- or MIT-licensed app: it obliges you to (a)
  keep `citeproc`'s attribution/notice intact and (b) publish source for any
  modifications **to `citeproc`'s own files** — it does **not** reach into or
  relicense your application code. Radarist uses `citeproc` as an **unmodified
  npm dependency**, so the only standing obligation is preserving its notice.
  Electing AGPL-1.0 instead would impose network-copyleft on modified copies —
  avoid that election.
- **Where it is used:** CSL citation formatting via `@citation-js/*` in
  `src/lib/research/citation.ts` (the same research-output citation path as the
  IEEE CSL style above). It is server-side only.
- **Removing it (optional):** drop `@citation-js/plugin-csl` (and, if unused
  elsewhere, `@citation-js/core`) from `package.json` and fall back to the
  hand-rolled `formatIeeeCitation` string formatter, which does not require the
  CSL engine.

## `@anthropic-ai/claude-agent-sdk` — Anthropic Commercial Terms (proprietary)

- **Package:** `@anthropic-ai/claude-agent-sdk` (declared in
  `agent/package.json`, installed into `agent/node_modules` only by the explicit
  `npm run setup:agents` / `setup:packages` commands, **not** in the root dependency tree). Note
  this is distinct from `@anthropic-ai/sdk` (the plain API client in the root
  `package.json`), which **is** MIT-licensed.
- **License:** its `package.json` declares `"SEE LICENSE IN README.md"` — i.e.
  it is governed by **Anthropic's Commercial Terms of Service**, not an OSS
  license. Use requires an Anthropic API key and acceptance of those terms.
- **Where it is used:** the Claude Agent SDK **mission runtime** in `/agent`
  (the `scout`/`evaluator`/`linker`/`curator`/`strategist`/`creator` profiles).
  It is not reachable from the Gemini-side helper layer (`src/lib/ai/`) or from
  any page that does not run a mission.
- **What this means for you:** the mission runtime is an **optional** subsystem.
  Core `npm run dev`, `npm run build`, and `npm run demo:full` neither install
  nor bundle it. Run `npm run setup:agents` only after accepting Anthropic's
  terms. Without that opt-in, Radarist does not install or invoke the Anthropic
  commercial agent SDK. The root dependency set still includes the copyleft
  and native/transitive exceptions listed in this file. Bundling and running
  the agent means accepting Anthropic's commercial terms.

## `@img/sharp-libvips-*` (libvips native library) — LGPL-3.0-or-later (transitive)

- **Package:** the `@img/sharp-libvips-<platform>` prebuilt binary packages
  (e.g. `@img/sharp-libvips-darwin-arm64`), pulled in **transitively** by
  `sharp`, which is itself a transitive dependency of `next`
  (`next@16` → `sharp@0.34.x` → `@img/sharp-libvips-*`). `sharp` itself is
  **Apache-2.0**; the bundled **libvips** image library it links is not.
- **License:** the `@img/sharp-libvips-*` packages ship libvips under
  **`LGPL-3.0-or-later`**.
- **What this means for you:** LGPL copyleft is satisfied by **dynamic
  linking** — `sharp` loads libvips as a shared library and Radarist ships it
  **unmodified** via npm, so the only obligations are (a) preserving the LGPL
  notice and (b) permitting a user to substitute a modified libvips. It does
  **not** reach into or relicense your application code.
- **Where it is used:** Next.js image optimization (the `next/image` pipeline).
  It is server-side only and is not imported directly by application code.
- **Removing it (optional):** `sharp` is an optional accelerator for `next` —
  omitting it makes Next.js fall back to its slower built-in image path, and the
  libvips subtree disappears with it.

## `buffers` — no license declared / "all rights reserved" (transitive)

- **Package:** `buffers@0.1.1`, pulled in **transitively** and deep in the tree:
  `exceljs@4.4.0` → `unzipper@0.10.14` → `binary@0.3.0` → `buffers@0.1.1`. It is
  a tiny, ~2013-era Buffer-array helper.
- **License:** its `package.json` declares **no `license` field at all**, which
  legally defaults to **"all rights reserved"** (no explicit grant of rights).
- **What this means for you:** a license-less dependency carries theoretical
  legal risk. In practice `buffers` was published to the public npm registry as
  a reusable module (implying intent to allow use) and is a trivial utility, but
  for a public release we disclose it explicitly rather than let it hide in the
  tree. It is server-side only, reached solely through the Excel-export path.
- **Removing it (optional):** it is only reachable via `exceljs` (spreadsheet
  export). Dropping `exceljs` removes its entire subtree, including
  `unzipper` → `binary` → `buffers`.
