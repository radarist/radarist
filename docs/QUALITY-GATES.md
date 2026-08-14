# Public Quality Gates

The generated public workflow runs on pushes to `main` and by manual dispatch.
It installs from lockfiles, uses pinned CI tool versions, and treats every
required job result as fail-closed.

## Required checks

| Area | Command or job | Acceptance |
| --- | --- | --- |
| install | `npm ci` | root lockfile installs without mutation |
| lint | `npm run lint` | zero errors and ≤ 64 warnings |
| types | `npm run typecheck` and `npm run typecheck:scripts` | no TypeScript errors |
| coverage | `npm run test:coverage` | ≥ 8500 tests, ≥ 400 suites, global statements / branches / functions / lines ≥ `52 / 41 / 44 / 52` |
| security | `npm run secret:scan`, `npm run test:security`, and `npm run test:security:browser` | secret detector is non-vacuous; retained security suites pass |
| dependencies | `npm audit --audit-level=critical` | zero critical advisories |
| code health | `npm run knip` | configured dependency and duplicate-export rules pass |
| structure | `npm run graph:structure:gate` | no new import cycles, orphan modules, unresolved imports, or client/server boundary regressions against the checked-in baseline |
| identity and docs | `npm run docs:check` | version, public Markdown links, and six-image inventory agree |
| emulators | `npm run test:emulator` | retained Firebase-emulator integration passes |
| Agent package | Agent install, lint, typecheck, test, build, and critical audit | independent package lock and checks pass |
| build | `npm run build` | production application and Agent build; generated docs remain a zero-diff fixed point |
| browser contract | `npm run e2e:contracts` | public lane ownership, discovery floors, and anti-soft-pass rules pass |
| browser acceptance | retained generic, accessibility, report-publication, and browser-security lanes | Chromium and owned local services pass without provider credentials |

The generated code-graph gate is baseline-relative; it does not hide new debt.
The public output baseline itself is required to contain zero orphans,
unresolved imports, and client/server boundary violations.

## Local commands before release use

```bash
npm ci
npm ci --prefix agent
npm run lint
npm run typecheck
npm run typecheck:scripts
npm run test:coverage
npm run test:security
npm run docs:check
npm run build
npm audit --audit-level=critical
npm audit --prefix agent --audit-level=critical
```

Java, Docker, and Chromium are required for emulator and browser lanes. Provider
credentials must remain unset unless a separate, explicitly paid evaluation is
intended. A deterministic local pass proves software behavior under its
fixtures; it does not prove live model quality.
