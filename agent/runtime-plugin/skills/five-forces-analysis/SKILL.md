---
name: five-forces-analysis
description: Use when evaluating industry structure — "how attractive is the X market?", "what are the competitive dynamics?", "barriers to entry", "supplier power", "buyer power", "threat of substitutes". Applies Porter's Five Forces to industry-level profitability drivers. For firm-level placement use `position-competitor` instead.
---

# Five Forces Analysis

Porter's framework for industry structure. Answers "how attractive is this market to enter or stay in?" — not "who wins?" (that's `position-competitor`).

## When to invoke

Trigger on phrases like "how attractive is the {X} industry?", "structural dynamics of {Y} market", "should we enter {Z}?", "barriers to entry in {W}", "what are the competitive pressures?", "why is this market so {profitable/unprofitable}?".

Skip for:

- Firm-level competitive questions — use `position-competitor` instead
- Markets in hypergrowth where structure changes annually — flag and use `scenario-planning` + `analysis-of-competing-hypotheses`
- Markets the user is already in and is asking about tactics, not strategy

## The five forces

| #     | Force                              | The question it answers                                                |
| ----- | ---------------------------------- | ---------------------------------------------------------------------- |
| **1** | Threat of new entrants             | How easy is it for a new player to enter and compete?                  |
| **2** | Bargaining power of suppliers      | Can key inputs (talent, tech, capital, data) squeeze industry margins? |
| **3** | Bargaining power of buyers         | Can customers push prices down or switch easily?                       |
| **4** | Threat of substitutes              | What alternative solves the same customer job differently?             |
| **5** | Rivalry among existing competitors | How fierce is the fight between incumbents?                            |

The **collective strength** of the five forces determines industry profitability. Strong forces → low profits. Weak forces → high profits.

## Force-by-force analysis rubric

Each force is assessed as **Low / Medium / High** against industry-specific indicators.

### Force 1 — Threat of new entrants

Indicators of **low** threat (strong incumbents):

- High capital requirements (e.g. semiconductor fab >$20B)
- Economies of scale critical to unit economics
- Strong network effects or switching costs
- Regulatory barriers (licensing, approval requirements)
- Proprietary distribution / customer access
- Deep IP moat (patents, trade secrets)

Indicators of **high** threat (easy entry):

- Low capital requirements
- Commodified inputs available
- No network effects
- Customers can switch trivially
- No regulatory moat

### Force 2 — Supplier power

Indicators of **high** supplier power (bad for industry):

- Few suppliers, many buyers (supplier-side concentration)
- No viable substitutes for supplier input
- Supplier input is differentiated / critical
- Threat of forward integration (supplier becomes competitor)
- Switching costs for industry players

Key input categories to check: **talent** (how scarce?), **technology** (proprietary deps?), **capital** (constrained funding?), **data** (unique datasets?).

### Force 3 — Buyer power

Indicators of **high** buyer power (bad for industry):

- Few buyers, many suppliers (buyer-side concentration)
- Buyer's switching cost is low
- Product is standardized / commoditized
- Buyer can backward-integrate
- Buyer's purchase is a large % of buyer's costs (price-sensitive)
- Information symmetry (buyers know pricing benchmarks)

### Force 4 — Threat of substitutes

Indicators of **high** threat:

- Another technology solves the same job at lower cost
- Another technology solves the same job at higher quality
- Substitute's price-performance ratio improves faster than this industry's
- No switching cost to substitute
- Customer's **job-to-be-done** has a different fulfillment path emerging

Substitutes are different from competitors — a competitor makes the same thing, a substitute replaces the need for the thing.

### Force 5 — Rivalry

Indicators of **high** rivalry (bad for industry):

- Many similarly-sized players (no dominant firm)
- Slow industry growth (fight for share, not growth)
- High fixed costs (pressure to fill capacity at any price)
- Differentiation is low (price competition)
- High exit barriers (can't leave, must compete)
- Large strategic stakes (important for portfolio players)

## Procedure

### 1 — Define the industry precisely

"AI" is not an industry. "LLM API services for enterprise customers in North America" is. Scope: **product category × buyer segment × geography × time frame**.

Narrower → more accurate force assessment. Too broad → forces average out to "medium" for everything and the analysis says nothing.

### 2 — Assess each force with 3–5 indicators

For each force, cite specific indicators with evidence. Example for Force 1 (AI API industry):

- Capital requirement: $100M+ pretraining cost → **HIGH** entry barrier
- Talent scarcity: <5,000 people globally with frontier-training expertise → **HIGH** entry barrier
- Compute access: NVIDIA H100/B200 allocation controlled by 3 hyperscalers → **HIGH** entry barrier
- Network effects: yes, via developer-community + integrations (LangChain, LlamaIndex ecosystem lock-in) → strong incumbents
- **Verdict: Low threat of new entrants** (at frontier tier)

### 3 — Produce the structural verdict

Add up the forces. The more "high" scores, the worse the industry structure.

| Forces / Verdict | Implication                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| Mostly Low       | **Attractive industry** — high profitability possible                  |
| Mixed Low/Med    | **Moderately attractive** — profitability depends on positioning       |
| Mostly High      | **Structurally unattractive** — hard to profit without unique position |

### 4 — Identify dynamics (how the forces are changing)

A static snapshot is less useful than the trajectory. For each force:

- Which indicators are trending? (e.g. "compute access is easing as Amazon/Google add AI chips — Force 1 trending _higher_ threat")
- What 2-year outlook?
- Which force is most likely to change the structure?

### 5 — Actionable takeaways

The five-forces analysis should conclude with strategic implications:

- Which forces drive current profitability? → protect / strengthen them
- Which forces are weakening? → prepare for margin compression there
- Which forces create opportunity for a well-positioned entrant? → the strategic play

### 6 — Format

```
## Five Forces — {industry scope}

**Industry scope:** {product category} × {buyer segment} × {geography} × {year}

**Force-by-force:**

### 1. Threat of new entrants: **{Low / Med / High}**
- Indicator 1: {evidence} → {directional contribution}
- Indicator 2: {evidence} → {directional contribution}
- ...
- **Verdict:** {Low/Med/High}

### 2. Supplier power: **{Low / Med / High}**
{same format}

### 3. Buyer power: **{Low / Med / High}**
{same format}

### 4. Threat of substitutes: **{Low / Med / High}**
{same format}

### 5. Rivalry: **{Low / Med / High}**
{same format}

**Structural verdict:** {industry is attractive / moderately attractive / unattractive}

**2-year dynamics:**
- Force with biggest trajectory change: {force name} → {direction + reason}
- Profitability trend: {rising / stable / falling}

**Strategic implications:**
- {one actionable sentence per relevant stakeholder}

**Confidence:** {0.0–1.0}
```

## Pair with adjacent skills

- `position-competitor` — firm-level positioning within the industry assessed here. Five Forces = industry structure; Position = firm placement.
- `apply-hype-cycle` — provides the timing dimension (where is this industry on the maturity arc?).
- `estimate-market-size` — the sizing of the industry being analyzed (TAM/SAM/SOM).
- `premortem-analysis` — stress-test the "we should enter this industry" recommendation that often follows Five Forces.

## Anti-patterns

- Do **not** confuse "firm-level competition" with "industry rivalry." Rivalry is the fifth force, not the whole analysis.
- Do **not** assess with <3 indicators per force. A single-indicator force assessment is overfit.
- Do **not** treat all forces as equal. Usually 1–2 forces dominate profitability; name which.
- Do **not** apply to markets in hypergrowth (>3× YoY). Structure is too volatile; scenarios > structural analysis in those cases.
- Do **not** conflate substitutes and competitors. Uber's competitor is Lyft; Uber's substitute is a private car, public transit, or walking.

## Reference

- M. E. Porter, "The Five Competitive Forces That Shape Strategy," _Harvard Business Review_, Jan. 2008 (updated from original 1979 _HBR_ article and _Competitive Strategy_ 1980).
- M. E. Porter, _Competitive Strategy: Techniques for Analyzing Industries and Competitors_, Free Press, 1980 (book-length treatment).
- C. M. Christensen, _The Innovator's Dilemma_, Harvard Business Press, 1997 — complementary on disruption as a substitute-force dynamic.
- Pairs with `position-competitor` (firm-level complement), `apply-hype-cycle` (timing dimension), `premortem-analysis` (stress-test implications), `scenario-planning` (branching futures for a force-driven industry).

## Radarist binding

**Route** (minimum viable = the 2 marked ★):

1. ★ `findVendors` — supplier concentration is a count, not an impression.
2. ★ `compareCompetitors` / `getGraphNeighbors` — rivalry intensity from the actual competitive neighbourhood.
3. `listCommunityClusters` — substitutes often sit in an adjacent community rather than the obvious one.
4. `searchSecFilings` — margins, concentration disclosures and customer-dependency risk, straight from filings.

State which forces you scored from graph or filing data and which remain judgement. A force scored from neither is an opinion and should be labelled one.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named below, then record the gap with `recordKnowledgeGap` rather than inventing the value.
