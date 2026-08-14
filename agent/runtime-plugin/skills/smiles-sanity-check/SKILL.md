---
name: smiles-sanity-check
description: Use whenever a SMILES string appears — in a prompt about a chemistry or biotech signal, in a patent claim, in a paper's methods section, or in a structured field on a Technology or Signal. Structural syntax check — balanced brackets, valid atoms, valid bond and ring tokens — to catch copy-paste corruption and hallucinated structures. Not chemistry semantics.
---

# SMILES Sanity Check

## Scope

This skill catches **syntactically invalid** SMILES strings before they propagate into the graph or a report. It is a regex-level format checker — no RDKit, no OpenBabel, no chemistry rules.

What it catches:

- Unbalanced brackets `[`, `(`, `)`, `]`.
- Mismatched ring-closure digits (opened `1` never closed, etc.).
- Atoms not on the SMILES atom list.
- Aromatic-lowercase atoms that aren't `b`, `c`, `n`, `o`, `p`, `s`, or `se` / `as`.
- Obviously-hallucinated characters (emoji, unicode, unknown letters).
- Impossible bond tokens (double symbols, bad stereochemistry marks).

What it does NOT catch:

- Chemically nonsensical structures that happen to be syntactically valid (e.g., a 7-valent carbon).
- Wrong stereochemistry.
- Mismatched tautomers.
- Invalid SMARTS patterns.

For those, the right upgrade path is an `rdkit-normalize` skill with a bundled Python script that imports `rdkit.Chem.MolFromSmiles`. That's a separate build.

## The procedure

### 1 — Identify the SMILES string

Look for:

- Backtick-fenced blocks: `` `C(=O)Oc1ccccc1C(=O)O` ``
- Inline mentions: "the SMILES `CC(=O)Oc1ccccc1C(=O)O` is..."
- Fields labeled `smiles:`, `SMILES:`, or `canonicalSmiles`.

### 2 — Run the structural checks

#### Balanced brackets

Walk the string once, tracking three counters: `[`/`]` square, `(`/`)` paren, and ring-closure digits (digit → opened, same digit again → closed). At end, all three must be zero.

#### Atom whitelist

Valid atom symbols (case-sensitive where it matters):

- **Organic subset** (unbracketed): `B`, `C`, `N`, `O`, `P`, `S`, `F`, `Cl`, `Br`, `I`, plus aromatic `b`, `c`, `n`, `o`, `p`, `s`.
- **Extended aromatic** (bracketed only): `se`, `as`.
- **Bracketed**: any element symbol from the periodic table (H, He, Li, Be, B, C, N, O, F, Ne, Na, Mg, Al, Si, P, S, Cl, Ar, K, Ca, ...).
- **Inside brackets** also allowed: charge (`+`, `-`, `++`, `--`), isotope prefix (digit run before symbol: `[13C]`), chirality (`@`, `@@`), hydrogen count (`H`, `H2`, `H3`...), class labels after `:`.

Anything outside these → fail.

#### Bond tokens

Allowed: `-` single, `=` double, `#` triple, `$` quadruple, `:` aromatic explicit, `/` up, `\` down. Back-to-back bond tokens are invalid (e.g., `==` or `/=/` outside specific ring-closure contexts).

#### Ring-closure digits

Digits `0`–`9` and two-digit `%NN` (with `%`) are valid. Every opened digit must close exactly once.

### 3 — Output shape

For each SMILES, emit:

```
SMILES: C(=O)Oc1ccccc1C(=O)O
✓ brackets balanced (paren: 2↓2↑ · sq: 0↓0↑)
✓ ring closures matched (1: open-close)
✓ all atoms in whitelist (C, O, c)
✓ bond tokens valid (=, aromatic implicit)
PASS
```

or

```
SMILES: Ccc(=O)OC1=CC=CC=C1Xz
✗ atom "Xz" not on whitelist (expected element symbol)
✗ ring closures: digit 1 opened but never closed
FAIL — review or re-source
```

### 4 — On failure

Invoke `abstain-or-escalate` — a failed SMILES signals the source is corrupt, hallucinated, or has been mis-copied. Do not propagate it to the graph. Either:

- Re-source the SMILES from primary literature (paper, patent claim).
- Drop the claim + note in the report.
- Escalate if chemistry correctness is load-bearing.

## Anti-patterns

- Do **not** pretend this validates chemistry. It validates syntax. An unstable radical or non-existent isomer can still pass.
- Do **not** silently fix SMILES. If it's broken, surface it — autocorrect masks data-quality signals.
- Do **not** run this on SMARTS (substructure search language). SMARTS extends SMILES with wildcards and different semantics; use a SMARTS-specific checker if/when that surface arrives.
- Do **not** include this in chat responses that don't involve chemistry. Trigger only on explicit SMILES presence.

## Reference

- Daylight Chemical Information Systems, "SMILES — A Simplified Chemical Language," specification available at https://daylight.com/dayhtml/doc/theory/theory.smiles.html
- W. Weininger, "SMILES, a chemical language and information system. 1. Introduction to methodology and encoding rules," _Journal of Chemical Information and Computer Sciences_, vol. 28, no. 1, pp. 31–36, Feb. 1988. doi: 10.1021/ci00057a005.
