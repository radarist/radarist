---
name: chemistry-claim-check
description: Use when a chemistry or biotech signal, patent, or paper states a molecular claim in prose — a compound name with a formula ("caffeine, C8H10N4O2"), a molecular weight, or a "drug-like"/"orally bioavailable" assertion. Checks name-vs-formula consistency, impossible valences, MW plausibility, and Lipinski rule-of-five. For a SMILES string use `smiles-sanity-check` instead.
---

# Chemistry Claim Check

## Scope

This skill catches **internally inconsistent chemistry prose** before it propagates into the graph or a report. It is markdown-only arithmetic and lookup — no RDKit, no OpenBabel, no scripts, no external databases.

This is **heuristic sanity-checking, not computational chemistry.** It cannot confirm a structure is real, stable, synthesizable, or biologically active. It can only flag claims whose own numbers or formulas contradict each other or basic bonding rules.

Division of labor with `smiles-sanity-check`:

- `smiles-sanity-check` — syntactic validation of SMILES **strings** (brackets, atoms, ring closures).
- `chemistry-claim-check` (this skill) — the **prose claims** around a molecule: name, formula, molecular weight, drug-likeness.

Both share the same upgrade path: anything needing real chemistry semantics (valence-checked structures, logP computation, tautomers) belongs to a future `rdkit-normalize` skill with a bundled Python script. That's a separate build — do not bolt scripts onto this one.

## The procedure

### 1 — Identify the chemistry claims

Look for:

- A compound name next to a molecular formula: "aspirin (C9H8O4)", "the API, C21H23NO5".
- A stated molecular weight: "MW 194.19", "194 g/mol", "molar mass of ~500 Da".
- Drug-likeness language: "orally bioavailable", "drug-like small molecule", "lead compound", "Lipinski-compliant".
- Structured fields: `formula:`, `molecularWeight:`, `compound:` on a Signal or Technology entity.

### 2 — Name vs formula consistency

For well-known compounds, the formula is a lookup, not a judgment call. Check the stated formula against the canonical one:

| Compound (common in signals)   | Canonical formula |
| ------------------------------ | ----------------- |
| Water                          | H2O               |
| Ethanol                        | C2H6O             |
| Glucose                        | C6H12O6           |
| Aspirin (acetylsalicylic acid) | C9H8O4            |
| Caffeine                       | C8H10N4O2         |
| Ibuprofen                      | C13H18O2          |
| Paracetamol (acetaminophen)    | C8H9NO2           |
| Penicillin G                   | C16H18N2O4S       |
| Methane / CO2 / ammonia        | CH4 / CO2 / NH3   |

Example: "ethanol (C2H6O2)" → **fail** — ethanol is C2H6O; C2H6O2 is ethylene glycol. A swapped formula is a classic copy-paste/hallucination artifact and often means the _rest_ of the claim was lifted from the wrong compound.

For named compounds not in common knowledge (novel drug candidates, IUPAC mouthfuls), do **not** guess the formula. Mark name-vs-formula as `unverified` — external verification is `grounded-fact-check` territory.

### 3 — Impossible-valence and impossible-formula flags

Typical valences (neutral, organic context): C = 4, N = 3, O = 2, H = 1, halogens (F/Cl/Br/I) = 1, S = 2/4/6, P = 3/5. A prose claim that implies more bonds than the atom supports ("pentavalent carbon center") is an automatic flag.

For C/H/N/O formulas, compute the **degree of unsaturation** (DBE):

```
DBE = C − H/2 + N/2 + 1     (O and S don't enter; halogens count as H)
```

DBE must be a non-negative integer (or half-integer only for radicals/ions, which prose rarely intends):

- C2H7N → 2 − 3.5 + 0.5 + 1 = 0 ✓ (ethylamine — saturated, no rings)
- C2H8O → 2 − 4 + 0 + 1 = −1 ✗ — impossible; no neutral molecule can carry that many hydrogens
- C6H6 → 6 − 3 + 0 + 1 = 4 ✓ (benzene — one ring + three double bonds)

A negative or fractional DBE means the formula itself is corrupt — stop and re-source before checking anything downstream of it.

### 4 — Molecular-weight plausibility from formula

Recompute the MW from the formula with standard atomic masses (H 1.008, C 12.011, N 14.007, O 15.999, S 32.06, P 30.974, F 18.998, Cl 35.45, Br 79.904, I 126.90) and compare to the stated value.

Worked example: "caffeine, C8H10N4O2, MW 312 g/mol"

```
8 × 12.011 = 96.088
10 × 1.008 = 10.080
4 × 14.007 = 56.028
2 × 15.999 = 31.998
            ────────
              194.19 g/mol
```

Stated 312 ≠ computed 194.19 → **fail**. (312.4 happens to be near caffeine citrate's heavier fragments or a different salt form — a common source of MW mismatches: the claim mixes the free base's formula with a salt's weight. Flag, don't reconcile.)

Tolerance: within ±1 g/mol of the recomputed value passes (rounding, isotope conventions). A few % off suggests a salt/hydrate mix-up; >10% off suggests the wrong compound entirely.

### 5 — Lipinski rule-of-five drug-likeness heuristic

For biotech/pharma signals and patent claims asserting an **oral small-molecule drug candidate**, apply Lipinski's rule of five. A compound is "drug-like" (for oral absorption) when it has no more than one violation of:

- Molecular weight ≤ 500 g/mol
- logP ≤ 5
- H-bond donors ≤ 5 (OH + NH count)
- H-bond acceptors ≤ 10 (N + O count)

What this skill can check from a formula alone: MW (step 4) and a crude acceptor ceiling (N + O count). Donors and logP need a structure — if a SMILES is present, run `smiles-sanity-check` first and count OH/NH from it cautiously; otherwise mark those criteria `not assessable`.

Worked example: a patent claims "an orally bioavailable inhibitor, C39H47N5O9S (MW ≈ 762)". MW 762 > 500 and N+O = 14 > 10 → two rule-of-five violations. That does **not** disprove the claim — many modern drugs (notably macrocycles and PROTACs) live beyond the rule of five — but "orally bioavailable" now carries an elevated burden of proof. Tag the claim and lower confidence accordingly rather than rejecting it.

### 6 — Output shape

```
Compound claim: caffeine — C8H10N4O2 — "MW 312 g/mol" — "drug-like"
✓ name vs formula: C8H10N4O2 matches caffeine
✓ DBE: 8 − 5 + 2 + 1 = 6 (integer, ≥ 0)
✗ MW: computed 194.19 g/mol ≠ stated 312 g/mol (likely salt-form mix-up)
✓ Lipinski (assessable subset): MW 194 ≤ 500, N+O = 6 ≤ 10
RESULT: FAIL — MW inconsistent; re-source before graph write
```

### 7 — On failure

As with `smiles-sanity-check`, a failed check signals a corrupt, conflated, or hallucinated source. Invoke `abstain-or-escalate`:

- Re-source the compound data from primary literature (paper, patent, PubChem-grade reference) via `grounded-fact-check`.
- Drop the chemistry specifics from the claim and keep only what survives.
- Escalate if the chemistry is load-bearing for the signal's relevance.

## Anti-patterns

- Do **not** present a pass as chemical validation. A consistent name/formula/MW triple can still describe an unstable, unsynthesizable, or biologically inert molecule.
- Do **not** silently correct a formula or MW. Surface the mismatch — autocorrect masks data-quality signals.
- Do **not** treat Lipinski violations as disqualifying. The rule of five is a heuristic for _oral small molecules_; biologics, macrocycles, and degraders legitimately violate it. Report violations as confidence modifiers, not verdicts.
- Do **not** guess formulas for unfamiliar compound names. `unverified` is an honest answer; a guessed formula is a manufactured fact.
- Do **not** bolt scripts or external lookups onto this skill. The scripted upgrade path is `rdkit-normalize` (see `smiles-sanity-check`), not an expansion here.

## Reference

- C. A. Lipinski, F. Lombardo, B. W. Dominy, and P. J. Feeney, "Experimental and computational approaches to estimate solubility and permeability in drug discovery and development settings," _Advanced Drug Delivery Reviews_, vol. 23, no. 1–3, pp. 3–25, 1997. doi: 10.1016/S0169-409X(96)00423-1
- Degree of unsaturation / DBE: F. W. McLafferty and F. Tureček, _Interpretation of Mass Spectra_, 4th ed. University Science Books, 1993.
- IUPAC atomic weights: T. Prohaska et al., "Standard atomic weights of the elements 2021," _Pure and Applied Chemistry_, vol. 94, no. 5, pp. 573–600, 2022. doi: 10.1515/pac-2019-0603
- Pairs with `smiles-sanity-check` (string-level syntax), `grounded-fact-check` (external re-sourcing on failure), and `rate-source-admiralty` (grade the source supplying the compound data).
