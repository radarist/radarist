# Build-mission sandbox template

Everything in this directory is baked into the sandbox image at
`/opt/impulse/template/` and copied into the mission workspace on first run
(Phase 1+), or copied manually into a scratch dir for Phase 0 methodology
runs. It is the single source of truth for the in-sandbox methodology.

## Inventory

| Template path             | Workspace path                    | Purpose                                                                                       |
| ------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `skills/*/SKILL.md`       | `.claude/skills/*/SKILL.md`       | Methodology pack: `mission-methodology` (master state machine) + 9 phase skills               |
| `hooks/gate-lib.mjs`      | `.claude/hooks/gate-lib.mjs`      | Zero-dependency enforcement logic (glob-matched check runs, stop gate)                        |
| `hooks/post-tool-test.sh` | `.claude/hooks/post-tool-test.sh` | PostToolUse wrapper → `gate-lib.mjs post-tool`                                                |
| `hooks/stop-gate.sh`      | `.claude/hooks/stop-gate.sh`      | Stop wrapper → `gate-lib.mjs stop`                                                            |
| `settings.json`           | `.claude/settings.json`           | Wires the two hooks                                                                           |
| `workspace.gitignore`     | `.gitignore`                      | Keeps build noise and session logs out of mission git history (stop gate refuses dirty trees) |

Provisioned per mission (NOT in this template): `MISSION.md` (the brief),
`.mcp.json` (generated from platform config), `.impulse/STATUS.json` seed,
git init.

## Contract files (written by the agent during a mission)

| File                                               | Written in phase            | Read by                                                     |
| -------------------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| `docs/00-inception.md` … `docs/05-adr.md`          | 00–05                       | next phases, QA reviewer, stop gate                         |
| `.impulse/checks.json`                             | 04                          | PostToolUse hook, stop gate, supervisor acceptance runs, QA |
| `.impulse/STATUS.json`                             | every transition            | supervisor (session planning), stop gate                    |
| `docs/07-test-report.md` + `.impulse/screenshots/` | 07                          | QA reviewer                                                 |
| `.impulse/qa-report.json`                          | 08 (fresh-context reviewer) | supervisor publish gate                                     |
| `.impulse/force-stop`                              | supervisor only             | stop gate (escape hatch when killing a session at a cap)    |

## Enforcement model (three layers)

1. **Skills persuade** — the methodology pack above.
2. **Hooks enforce** — edits that break matched checks are blocked with the
   failing output; sessions cannot end without completed-phase artifacts,
   green done-story checks, and a finished mission / fresh QA report /
   fresh handoff.
3. **The supervisor verifies** — (Phase 2+) acceptance checks run via
   `docker exec` from outside; the agent's self-report is never trusted.

## Kickoff (frozen — iterate the skills, never this prompt)

```bash
claude -p "Read MISSION.md and execute it following the mission-methodology skill." \
  --output-format stream-json --verbose --max-turns 80
```

Every behavioral fix discovered during runs becomes a sentence in the
relevant `SKILL.md`, keeping the runtime methodology self-contained.
