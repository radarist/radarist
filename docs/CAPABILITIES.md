> GENERATED FILE — do not edit by hand. Run `npm run capabilities:generate`.

# Radarist Capabilities

## Skills (56)

### Analysis & forecasting (16)

- **analysis-of-competing-hypotheses** — Use when a question has several plausible explanations and the wrong pick is costly — adoption stalls, competitive shifts, unexplained failures, surprising signals. Runs Heuer's ACH — enumerate hypotheses, score evidence C/N/I/NA, favour fewest inconsistencies. For stress-testing an already-chosen plan use `premortem-analysis` instead.
- **apply-hype-cycle** — Use for "is X overhyped?", "peak hype?", "past the trough?", "Gartner Hype Cycle for …", "adoption stage of X", "is this a fad?". Places a technology on Gartner's five stages from observable indicators, plus a years-to-plateau estimate. For one dated prediction use `foresight` instead; for branching futures use `scenario-planning` instead.
- **assess-research-momentum** — Use for "is research on X heating up?", "is this a hot area?", "publication trend for X", "is the field maturing?". Reads a `searchPapers` result set into a momentum signal — publication S-curve, citation velocity, author concentration, research-front vs mature.
- **bayesian-update** — Use to revise a belief in light of new evidence rather than treating new data as decisive — "does this change my mind?", "how much should this move my estimate?", "update my prior", "posterior probability", "is this signal strong enough to act on?". A transparent Bayes-factor update — state the prior, assess evidence likelihood under each hypothesis, combine into a posterior. Guards against base-rate neglect.
- **brier-score-calibration** — Use to score a prediction once its outcome is known, or to grade a set of probabilistic forecasts — "how accurate was that forecast?", "score my predictions", "was I overconfident?", "calibration check", "Brier score". Computes Brier's strictly-proper score and decomposes it into reliability and resolution. Closes the loop on `foresight`, which makes dated predictions that nothing currently scores.
- **cynefin-classification** — Use at the start of a strategic brief that recommends action under uncertainty — "what should we do about X?", "how do we navigate this market?", "what's our move in {emerging area}?". Opens the brief with the decision domain (Clear / Complicated / Complex / Chaotic per Snowden) and its matching decision mode.
- **estimate-market-size** — Use when sizing a market — "how big is the X market?", "TAM / SAM / SOM for …", "multi-billion market", "expected to reach $X by Y", "market valued at". Triangulates a top-down and a bottom-up estimate that must agree within an order of magnitude, else the claim is rejected as unsupported.
- **evolution-stage** — Use when a brief names technologies, capabilities, or vendor categories — tech comparisons, ecosystem maps, buy-vs-build matrices, radar landscape reports. Tags each with a Wardley evolution stage (Genesis / Custom-built / Product / Commodity) plus an evidence-anchored rationale. For empirical readiness use `score-technology-readiness` instead.
- **five-forces-analysis** — Use when evaluating industry structure — "how attractive is the X market?", "what are the competitive dynamics?", "barriers to entry", "supplier power", "buyer power", "threat of substitutes". Applies Porter's Five Forces to industry-level profitability drivers. For firm-level placement use `position-competitor` instead.
- **foresight** — Use for "when will X happen?", "is this accelerating or stalling?", "what should we watch?", "by what date…?" — a dated prediction about one technology, trend, or market shift. Names the prediction, accelerants, blockers, weak signals to monitor, kill-signals, and a review horizon. For branching futures use `scenario-planning` instead; to score the prediction once resolved use `brier-score-calibration` instead.
- **jtbd-framing** — Use when a brief compares technologies, vendors, or products — "which of these should we adopt?", "how do these vendors compare?", "buy vs build", "ecosystem of {category}". Produces a verb-led outcome-driven job statement per technology, the competing solutions including non-consumption, and the struggling moment.
- **position-competitor** — Use when placing a company or technology on a 2D competitive landscape — "where does X sit vs Y?", "competitive positioning", "market map", "who are the leaders in category Z?", "magic quadrant for …". Axis selection, evidence-based placement, whitespace, orthogonality check. For industry structure use `five-forces-analysis` instead.
- **scenario-planning** — Use when the future is genuinely uncertain and a single-point forecast is inadequate — "what could happen to X over the next 3–5 years?", "plausible futures", "2x2 scenarios", "alternative futures", "driver analysis". Shell's method — two critical uncertainties, a 2×2 matrix, each future narrated with triggers. For one dated prediction use `foresight` instead.
- **score-technology-readiness** — Use when placing a technology on a capability ring or answering "how ready is X?", "is this production-grade?", "can I deploy this?", "what TRL is it?", "is this proven at scale?". Applies NASA's 9-level TRL scale adapted for software and AI, with the evidence required per level. For strategic-method fit use `evolution-stage` instead.
- **three-horizons** — Use when a brief proposes a portfolio of bets, capabilities, or technologies — investment briefs, transformation roadmaps, "where should we focus?", "what's our portfolio across the next 5 years?". Tags every bet H1 (0–12 months), H2 (1–3 years), or H3 (3–5 years) with a time-to-revenue-impact estimate.
- **weak-signal-triage** — Use when a signal is sparse but potentially important — one source, an unknown actor, an anomaly that does not fit current models, "is this noise or early?", "too early to tell". Scores amplitude and potential impact as two separate axes so a genuine weak signal is not discarded for being sparse. For an already well-sourced signal use `evaluate-signal` instead.

### Critique & rigor (11)

- **abstain-or-escalate** — Use when a claim, relation, evidence snippet, or report line has no verifiable source — decide between refusing, escalating, or surfacing the disagreement rather than guessing. Runs after `grounded-answer` step 3 returns no usable source.
- **assess-study-bias** — Use to evaluate a clinical trial, empirical study, benchmark comparison, or published experiment for methodological weakness — "is this study reliable?", "assess bias in …". Applies the Cochrane RoB-2 five domains — selection, performance, detection, attrition, reporting.
- **benchmark-model-claims** — Use when a vendor, paper, or release claims performance — "X% on HumanEval", "outperforms GPT-5", "SOTA on MMLU", "3× faster than competitor", leaderboard entries. Checks baseline freezing, contamination risk, seed averaging, evaluator blinding, and metric cherry-picking; emits a ReliabilityScore 0–5 with risk tags.
- **cheapest-experiment** — Use when a brief contains recommendations or a next-steps section — "what should we invest in?", "should we pilot X?", "should we acquire Y?". Forces every recommendation to name the smallest validating test, its cost and duration, and an explicit pass/fail decision rule.
- **critique-report** — Use after a report or brief is drafted and before it reaches a user. Runs a 10-point structural self-review — question answered, evidence sourced, anti-patterns avoided, reproducible, confidence honest — plus three conditional innovation-practice points. For a single headline claim use `red-team-claim` instead.
- **key-assumptions-check** — Use before relying on a conclusion that rests on unexamined premises — "what are we assuming here?", "what would have to be true for X to hold?", "stress-test our reasoning". Heuer's Key Assumptions Check — enumerate the premises a conclusion depends on, rate each for sensitivity and grounding, then re-source or kill the ones that are both sensitive and ungrounded. For comparing whole rival hypotheses use `analysis-of-competing-hypotheses` instead.
- **premortem-analysis** — Use before committing to a strategy, recommendation, roadmap, or investment — "should we invest in X?", "is this the right strategy?", "what could go wrong?", "before we commit to this plan…". Kahneman's premortem — assume it failed 12 months out, work backwards to failure modes, likelihoods, and mitigations. For choosing between rival explanations use `analysis-of-competing-hypotheses` instead.
- **quantitative-sanity-check** — Use when a document, signal, or report states numbers that should be internally consistent — CAGR from $A to $B by a year, revenue/users/price triples, "improved 5%" (percent or percentage points?), survivorship framing, Fermi-style headline figures. Recomputes the source's own arithmetic. Internal consistency only — no external sources.
- **red-team-claim** — Use before a report's headline claim reaches a user — "our conclusion is {X}", "the key takeaway is {Y}". Adversarial review — what a skeptical reviewer, a competitor's analyst, or a regulator would say against it. Names attack vectors and forces a fix, a hedge, or a retraction. For whole-report structure use `critique-report` instead.
- **steelman-argument** — Use before refuting an opposing view, to be sure you are attacking its strongest form — "steelman the opposing case", "strongest argument for X", "am I strawmanning?", "the best case against my position". Builds the most charitable version of the opposing argument to the standard its actual proponents would endorse. For attacking your own headline claim use `red-team-claim` instead.
- **test-significance** — Use when a claim rests on "X is significantly better/bigger/faster than Y" — "Model A scored 87% vs Model B's 85%", "12% more clicks", "the new variant improved conversion". Checks whether the gap is meaningful given sample size and variance, and names the statistic to report.

### Domain checks (7)

- **analyze-patent-claims** — Use for one patent filing or granted patent — "US11234567", "EP3456789B1", PCT/WIPO application, "patent-pending", freedom-to-operate, prior art, IPC/CPC code. Parses independent and dependent claims into a structured PatentEvent. For assignee concentration and white space across many filings use `read-patent-landscape` instead.
- **analyze-release-notes** — Use for a release note, changelog, or version announcement — "v2.4 released", semver bump, "breaking changes", deprecation notice, or a CVE alongside a version. Parses it into a structured ReleaseEvent and grades signal strength for graph ingestion.
- **chemistry-claim-check** — Use when a chemistry or biotech signal, patent, or paper states a molecular claim in prose — a compound name with a formula ("caffeine, C8H10N4O2"), a molecular weight, or a "drug-like"/"orally bioavailable" assertion. Checks name-vs-formula consistency, impossible valences, MW plausibility, and Lipinski rule-of-five. For a SMILES string use `smiles-sanity-check` instead.
- **detect-funding-round** — Use for a capital raise — "Series A/B/C/D", "seed round", "raised $X million/billion", "closed a funding round", "announces financing", "valued at $X". Parses it into a structured FundingEvent — amount, stage, date, lead investor, participants, post-money valuation.
- **detect-ma-event** — Use for a transaction — "acquired", "merger", "buyout", "takeover", "all-cash deal", "stock swap", "go-private", "carve-out", "definitive agreement". Parses it into a structured MAEvent — acquirer, target, consideration, deal value, close, jurisdictions, termination fee — and flags deal-structure risk.
- **read-patent-landscape** — Use when reading a cluster of patents for competitive or white-space signal — "who owns the IP around X?", "patent landscape for X", "is this space getting crowded?", "where's the white space?". Reads assignee concentration, family growth, CPC clustering, and filing velocity. For one filing's claims use `analyze-patent-claims` instead.
- **smiles-sanity-check** — Use whenever a SMILES string appears — in a prompt about a chemistry or biotech signal, in a patent claim, in a paper's methods section, or in a structured field on a Technology or Signal. Structural syntax check — balanced brackets, valid atoms, valid bond and ring tokens — to catch copy-paste corruption and hallucinated structures. Not chemistry semantics.

### Reporting & radar (8)

- **design-pass** — Use when creating a visual report with charts or infographics. Establishes and enforces ONE design brief — theme, brand-exact palette, typography — across every chart, every infographic, and the report HTML. Two paths — CONCEPTION up front, and REVIEW before `publishReport`.
- **discover-relations** — Use when finding evidence-backed connections between entities for human review. Proposes candidates with honest per-relation evidence and never auto-applies. For an exact current user directive naming both entities use the curated `createRelation` path instead.
- **evaluate-signal** — Use when scoring a new signal for trust and relevance before triage. Grades source reliability, data completeness, and corroboration into an overall trust score with an explicit triage decision.
- **generate-radar-report** — Use when creating a radar landscape or strategic report. Gathers placements by ring and quadrant, identifies movements against the previous period, renders the radar figure inline, and ships through the draft-then-publish path.
- **pyramid-principle** — Use to structure a persuasive analytical argument or document — "structure this report", "make this argument land", "governing thought", "Minto pyramid", "execs keep asking what the point is". Minto's Pyramid — lead with one governing thought, support it with a MECE group of arguments, each backed by evidence, so the document reads top-down in 30 seconds or 30 minutes. For a one-page decision brief use `write-srl-brief` instead.
- **verify-entity** — Use when validating an entity's data quality and freshness. Checks staleness, cross-references current sources, records a verification result, and flags disputes for human review.
- **write-imrad-report** — Use for a scientific or research-style long-form report — a technical whitepaper, an empirical finding document, a landscape analysis needing academic rigor. Structures it as IMRAD (Introduction / Methods / Results / Discussion) with an optional executive summary and references. For a one-page decision brief use `write-srl-brief` instead.
- **write-srl-brief** — Use for a short decision-oriented briefing of one page or less — "give me a 1-pager on X", "brief me on Y", "SBAR", "executive summary of Z", "crisp summary". Structures it as Situation, Background, Assessment, Recommendation with strict length caps and a mandatory confidence tag. For an academic-shaped report use `write-imrad-report` instead; for the argument structure inside either use `pyramid-principle` instead.

### Research & evidence (14)

- **cite-ieee** — Use when a report, research document, or long-form response carries three or more cited sources. Converts URLs, DOIs, arXiv IDs, paper titles, filings, and news articles into IEEE numbered-bracket inline citations plus a numbered References section.
- **claim-provenance** — Use when a brief or report contains fact-claims — numbers ("$6.25B market", "24.8% CAGR", "60% YoY"), forward-looking projections, or any sentence a reader might act on. Tags each with `[validated, <source>]` or `[assumption, retire-by <milestone>]` per Discovery-Driven Planning.
- **decompose-research-question** — Use when a question is too large, vague, or multi-part to answer directly — "what's the future of X?", "analyze the {broad domain}", "compare all the Y", "help me understand Z". Breaks it into a tree of independently answerable sub-questions that recombine.
- **graph-as-instrument** — Use before answering a question the knowledge graph could answer better than recall — "what changed on my radar?", "which claims are contradicted?", "what are we missing?", "where are things converging?", "what should I look at next?". Opens with structure, gaps, temporal deltas, and claim health rather than a web search. For a single factual lookup use `grounded-answer` instead.
- **grounded-answer** — Use before any factual answer that reaches a user, is saved to a stored record, enters a report, or influences a decision. Runs the four-step Chain-of-Verification cycle — draft, plan verification questions, answer them independently against graph and web sources, then revise. Skip for turns with no factual claims.
- **grounded-fact-check** — Use before publishing a report that states load-bearing specifics — vendor and product numbers, benchmark scores, market figures, dates, named standards, "X overtook Y in YYYY", percentages a reader would act on. Verifies each value against a grounded search and reconciles the draft. For identifier format validation use `verify-citations` instead.
- **oss-project-health** — Use when assessing an open-source project's viability — "is this project maintained?", "bus factor", "is it dying?", "should we depend on this?". Reads `searchOssHealth` signals — release cadence, contributor concentration, issue latency — into a maintenance verdict.
- **rate-source-admiralty** — Use to record how trustworthy a source is — an incoming signal, an evidence snippet, a report citation, a claim entering the knowledge graph. Assigns a two-axis NATO Admiralty grade (A1–F6) covering source reliability and information credibility. For a first-look check on an unfamiliar web source use `sift-source-check` instead; for verifying a specific stated value use `grounded-fact-check` instead.
- **research-company** — Use when discovering or enriching a company entity. Checks the graph first, researches primary sources, creates or updates the entity, and proposes evidence-backed relations for human review.
- **research-technology** — Use when discovering or enriching a technology entity. Checks the graph, gathers academic and patent evidence, assesses readiness and key players, then creates or updates the entity and proposes a radar placement.
- **sift-source-check** — Use before trusting, citing, or acting on a web source you do not already know — "is this source legit?", "can I trust this article?", "verify this link", "is this real?". Runs SIFT (Caulfield) — Stop, Investigate the source, Find better coverage, Trace claims to the original — by lateral search rather than by reading the suspicious page. For grading a source you have already accepted use `rate-source-admiralty` instead.
- **systematic-review** — Use for a comprehensive, reproducible survey of the literature or signal corpus — "what does the research say about X?", "comprehensive review of …", "systematic review", "what's the evidence base for …". Structures the process around PRISMA 2020 with an audit trail of why each source was included or excluded.
- **triangulate-sources** — Use when a claim warrants more than one source — a relation at confidence ≥ 75, an executive-summary claim, a signal flagged for auto-apply, an assertion that will propagate through graph traversals. Requires two independent corroborating sources, grades each, and emits a combined confidence with explicit source diversity. For verifying one stated value use `grounded-fact-check` instead.
- **verify-citations** — Use after `cite-ieee` produces a References section, or when a report contains DOIs, arXiv IDs, or URLs to check before publishing. Validates each identifier against its canonical format and surfaces ones that should be replaced. For checking whether a stated value is true use `grounded-fact-check` instead.

## Mission profiles (7)

- **creator** — Generates professional HTML reports and shareable artifacts from graph knowledge
- **curator** — Maintains data quality — fills gaps, fixes inconsistencies, enriches incomplete entities
- **defense-minister** — Data quality verifier — continuous entity validation, staleness detection, and fact-checking against web sources
- **evaluator** — Scores technologies, assesses maturity (TRL), and validates claims with evidence
- **linker** — Discovers and validates relationships between entities in the knowledge graph
- **scout** — Discovers new signals, companies, and technologies through web research, browser automation, and academic sources
- **strategist** — Analyzes patterns, connects trends to strategy, generates proactive insights

## Keyless research tools (6)

- **searchPapers** — Search real academic literature across OpenAlex, Crossref, and Semantic Scholar — three keyless, public scholarly indexes covering peer-reviewed papers, prepri…
- **resolveOpenAccess** — Resolve the open-access status and free full-text PDF location for a paper's DOI, via Unpaywall — the canonical public open-access database.
- **searchHackerNews** — Search Hacker News (stories, Show HN, Ask HN, comments) via the keyless HN Algolia API — a real-time pulse on what the developer/tech community is discussing r…
- **searchSecFilings** — Search real SEC filings (10-K, 10-Q, 8-K, S-1, etc.) via the SEC EDGAR full-text search API — the authoritative, keyless, public source for US public-company d…
- **searchOssHealth** — Look up open-source repository health metrics (stars, contributors, last commit, maintenance score) for a GitHub repo via the keyless Ecosyste.ms API.
- **searchPatents** — Search the patent landscape for a topic, keyword, or assignee via the keyless Google Patents search API — real filings with assignees and filing dates, plus th…

## Platform features (4)

- **research-missions** — Multi-agent research missions (kind 'research') run by the mission profiles — dispatched from chat via startMission; produce reports, verdicts, and graph updates tracked live on the Agent Runs page. _(live)_
- **build-missions** — Experimental sandboxed prototyping. The path is default-off and excluded from the qualified v0.1 surface because its sandbox image and external executable bundle are not fully pinned. Do not use it for sensitive or reproducible work. _(experimental; default-off; not qualified or supported in v0.1)_
- **limitless-build-mode** — Experimental higher-budget build mode layered on the unqualified build sandbox. It is default-off and outside the supported v0.1 prototype surface. _(experimental; default-off; not qualified or supported in v0.1)_
- **technology-evaluations** — Experimental hands-on evaluation implemented through the unqualified build sandbox. Ordinary assessment and radar triage remain available without enabling this path. _(experimental; default-off; not qualified or supported in v0.1)_

## Assistant surface (19 page types)

_The in-app AI assistant classifies every mounted route to a page type (`src/lib/ai/page-context.ts`) and offers these quick actions (`src/lib/ai/assistant-surface.ts`). Generated from the same route walker as the assistant-route-coverage CI gate._

### `dashboard`

Routes: `/dashboard`

- **Show Metrics** (`show_metrics`) — "Show me the current dashboard metrics" _(conversational/navigation — no single backing tool)_
- **Recent Activity** (`recent_activity`) — "What's the recent activity in the platform?" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `radar`

Routes: `/radar`, `/visualizations/radar`

- **Analyze Trends** (`analyze_trends`) — "Analyze the current technology trends on the radar" _(conversational/navigation — no single backing tool)_
- **Suggest Entries** (`suggest_entries`) — "Suggest new entries for the radar" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `relations-graph`

Routes: `/triage/relations`

- **Explain Graph** (`explain_graph`) — "Explain the relationships shown in this graph" _(conversational/navigation — no single backing tool)_
- **Find Clusters** (`find_clusters`) — "Find clusters of related entities in the graph" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `library`

Routes: `/library`

- **Filter Help** (`filter_help`) — "How can I filter the items in this list?" _(conversational/navigation — no single backing tool)_
- **Bulk Actions** (`bulk_actions`) — "What bulk actions can I perform here?" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `entity-list`

Routes: `/library/companies`, `/library/documents`, `/library/initiatives`, `/library/org-units`, `/library/pain-points`, `/library/prototypes`, `/library/strategies`, `/library/technologies`, `/library/use-cases`

- **Filter Help** (`filter_help`) — "How can I filter the items in this list?" _(conversational/navigation — no single backing tool)_
- **Bulk Actions** (`bulk_actions`) — "What bulk actions can I perform here?" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `entity-detail`

Routes: _none (legacy/redirected page type)_

- **Research** (`research_entity`) — "Research this entity" _(conversational/navigation — no single backing tool)_
- **Find Relations** (`find_relations`) — "Find related entities" _(conversational/navigation — no single backing tool)_
- **Summarize** (`summarize_entity`) — "Summarize this entity" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `signals`

Routes: _none (legacy/redirected page type)_

- **Explain Signals** (`explain_signals`) — "Explain the current signals in the triage queue" _(conversational/navigation — no single backing tool)_
- **Approve High** (`bulk_approve`) — "Approve all high-confidence signals" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `signal-triage`

Routes: `/triage/signals`, `/triage/signals/[id]`

- **Explain Signals** (`explain_signals`) — "Explain the current signals in the triage queue" _(conversational/navigation — no single backing tool)_
- **Approve High** (`bulk_approve`) — "Approve all high-confidence signals" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `agents`

Routes: `/agents/jobs`, `/agents/runs`, `/agents/runs/[id]`

- **Agent Help** (`agent_help`) — "How do AI agents work in this platform?" _(conversational/navigation — no single backing tool)_
- **Create Agent** (`create_agent`) — "Help me create a new AI agent" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `agent-create`

Routes: _none (legacy/redirected page type)_

- **Wizard Help** (`wizard_help`) — "Help me use the agent creation wizard" _(conversational/navigation — no single backing tool)_
- **Task Ideas** (`task_suggestions`) — "Suggest task ideas for a new agent" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `agent-monitor`

Routes: _none (legacy/redirected page type)_

- **Agent Status** (`agent_status`) — "What is the current status of my agents?" _(conversational/navigation — no single backing tool)_
- **Troubleshoot** (`troubleshoot_agent`) — "Help me troubleshoot an agent issue" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `agent-settings`

Routes: _none (legacy/redirected page type)_

- **Config Help** (`config_help`) — "Explain the agent configuration options" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `settings`

Routes: `/settings`

- **Settings Help** (`settings_help`) — "Explain the available settings" _(conversational/navigation — no single backing tool)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `reports`

Routes: `/reports`, `/reports/[id]`

- **List Reports** (`list_reports`) — "List my recent reports" _(backed by `listReports`, `getReportById`)_
- **Draft Report** (`draft_report`) — "Draft a new report summarizing recent findings" _(backed by `getArtifactFindings`, `startMission`)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `artifacts`

Routes: `/artifacts`, `/artifacts/[id]`

- **Recent Missions** (`list_missions`) — "Show my recent agent missions and their artifacts" _(backed by `listUserMissions`, `getMissionStatus`)_
- **Latest Findings** (`artifact_findings`) — "What did my recent evaluation artifacts find?" _(backed by `getArtifactFindings`)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `infographics`

Routes: `/infographics`, `/infographics/[id]`

- **New Infographic** (`generate_infographic`) — "Generate a new infographic from my radar data" _(backed by `listRadars`, `getRadarDetails`, `generateInfographic`)_
- **Visualize Data** (`visualize_data`) — "Create a data visualization from my current data" _(backed by `listRadars`, `getRadarDetails`, `generateVisualization`)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `knowledge-graph`

Routes: `/visualizations/graph`

- **Explain Graph** (`explain_graph`) — "Explain the relationships shown in this graph" _(conversational/navigation — no single backing tool)_
- **Communities** (`community_reports`) — "Summarize the communities in the knowledge graph" _(backed by `getCommunityReports`, `listCommunityClusters`)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `assessment-triage`

Routes: `/triage/assessment`, `/triage/assessment/[id]`

- **Pending Items** (`pending_assessments`) — "What assessments are pending my review?" _(backed by `getPendingProposals`)_
- **Approve Top** (`approve_top_assessment`) — "Approve the top pending assessment" _(backed by `getPendingProposals`, `approveAssessment`)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

### `insights`

Routes: `/triage/insights`, `/triage/insights/[id]`

- **My Insights** (`proactive_insights`) — "What proactive insights do you have for me?" _(backed by `getProactiveInsights`)_
- **What Next** (`personalized_recommendations`) — "What should I look at next based on my radar?" _(backed by `listRadars`, `getRadarDetails`, `getPersonalizedRecommendations`)_
- **Navigate** (`navigation_help`) — "Help me navigate the platform" _(conversational/navigation — no single backing tool)_

## Assistant tool surface (185 declared)

_Every declared AI tool is exactly one classification: **core** (offered to the chat model and external MCP — `CORE_AI_TOOLS`) or one exclusion reason below. The partition is enforced by `src/lib/ai/tool-surface-policy.ts` and its contract test; this classification does not change any authorization or confirmation boundary._

**138 core** · **47 excluded** across 4 reasons.

### Server-only (mission / pipeline context) (3)

- **draftDocument** — Mission-scoped write — only valid inside a running mission (bound missionId).
- **getPipelineStatus** — Daily-pipeline internal status — operational, not a chat capability.
- **triggerPipeline** — Manually runs the daily pipeline — operational, not a chat capability.

### Deferred (held off pending verification or owned by a UI lane) (17)

- **askGraphQuestion** — NL→Cypher — held back pending grounding verification (see CORE_AI_TOOLS comment).
- **dismissProposedRelation** — Proposed-relation triage — owned by the dedicated Triage UI lane, not chat.
- **findByConcept** — Concept-tag subsystem — experimental; not yet curated onto the chat surface.
- **findConceptGaps** — Concept-tag subsystem — experimental; not yet curated onto the chat surface.
- **findSimilarEntities** — Concept-tag similarity — superseded on chat by findEntitiesByMeaning (embeddings); held off.
- **findVendors** — Composite vendor-for-strategy read — not yet curated onto the chat surface.
- **formatCitations** — Internal citation formatter — chat grounds/cites inline; not exposed as a tool.
- **getClaimHealth** — Operational evidence-coverage diagnostic — not a user-facing chat capability.
- **getConceptMap** — Concept-tag subsystem — experimental; not yet curated onto the chat surface.
- **getGraphHealth** — Operational graph-health diagnostic — not a user-facing chat capability.
- **getTechSummary** — Composite technology executive summary — not yet curated onto the chat surface.
- **getTrendDetails** — Trend detail view — not yet curated onto chat; getTrends covers the aggregate.
- **getTrendSummary** — Trend summary view — not yet curated onto chat; getTrends covers the aggregate.
- **listInitiativesByOrgUnit** — Org-unit sub-query — covered by getOrgUnitDetails + relations; not curated onto chat.
- **listPainPointsByOrgUnit** — Org-unit sub-query — covered by getOrgUnitDetails + relations; not curated onto chat.
- **recordKnowledgeGap** — Concept-tag gap write — experimental subsystem; not exposed to chat yet.
- **rejectProposedRelation** — Proposed-relation triage — owned by the dedicated Triage UI lane, not chat.

### Safety (raw Cypher, bulk/cascade or unreviewed writes) (17)

- **bulkApproveHighConfidenceProposals** — Bulk proposal approval above a threshold — unreviewable batch write.
- **bulkApproveSignals** — Bulk signal approval — batch write is unreviewable one-shot from chat; triage UI owns it.
- **bulkCreateRelations** — Bulk relation creation — batch write bypasses per-edge review.
- **bulkRejectSignals** — Bulk signal rejection — batch write is unreviewable one-shot from chat; triage UI owns it.
- **bulkUpdateEntities** — Bulk entity update — batch write bypasses per-entity review.
- **captureEvidence** — Legacy document relation writer — withheld until it validates ontology, authoritative endpoints, typed evidence, and decision authority.
- **confirmPlacement** — HITL confirmation gate paired with the placement write flow, not a standalone chat call.
- **createRelationsByName** — Alternate relation writer — withheld from chat until it shares the exact user-directive versus discovery-proposal authority policy.
- **createRelationWithEvidence** — Alternate evidence relation writer — withheld from chat until inferred writes create a durable triage proposal.
- **curateRelation** — Legacy relation-status writer — withheld from chat because it is not bound to an exact current-turn decision or proposal terminal state.
- **deleteDecoupledTechnology** — Redundant complete technology cascade; chat uses the gated CORE deleteEntity path instead.
- **executeCypher** — Executes raw Cypher — withheld from the model; power access via the /cypher page.
- **explainCypher** — Raw Cypher tooling — kept off chat with the rest of the Cypher suite.
- **findAndLinkRelatedEntities** — AI auto-creates relations from content with no review step.
- **generateCypher** — Raw Cypher authoring — over-reach/low-grounding; power access via the /cypher page.
- **getCypherSchema** — Raw Cypher tooling — kept off chat with the rest of the Cypher suite.
- **validateCypher** — Raw Cypher tooling — kept off chat with the rest of the Cypher suite.

### Unsupported (superseded / duplicate of a canonical core tool) (10)

- **createCompanyWithResearch** — Superseded by createCompany + researchCompanyComprehensive.
- **createVerifiedSignal** — Superseded on chat by createSignalManual as the signal-creation path.
- **enrichTechnologyFromResearch** — Superseded by researchTechnologyComprehensive + updateEntity.
- **getDecoupledTechnologyDetails** — Superseded by getEntityDetails + searchDecoupledTechnologies.
- **getSignalDetails** — Superseded by getEntityDetails for signal detail.
- **moveDecoupledTechnologyRing** — Superseded by updateTechnologyOnRadar.
- **researchCompanyByName** — Superseded by researchCompany / researchCompanyComprehensive.
- **researchTechnology** — Superseded by researchTechnologyComprehensive.
- **researchWebPage** — Superseded by webScrape + researchCompanyComprehensive.
- **updateDecoupledTechnology** — Superseded by the canonical updateEntity path.

## Keyless-by-default data sources

| Source | Tool | License |
| --- | --- | --- |
| OpenAlex | searchPapers | CC0 |
| Crossref | searchPapers | Open (Crossref REST API) |
| Semantic Scholar | searchPapers | ODC-BY |
| Unpaywall | resolveOpenAccess | CC0 (data); email required |
| Hacker News (Algolia) | searchHackerNews | MIT API, public data |
| SEC EDGAR | searchSecFilings | US-gov public domain |
| Ecosyste.ms | searchOssHealth | CC-BY-SA 4.0 (attribution required) |
| Google Patents | searchPatents | Public patent data (keyless) |
