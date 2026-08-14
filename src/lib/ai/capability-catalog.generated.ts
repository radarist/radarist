// GENERATED FILE — DO NOT EDIT. Run `npm run capabilities:generate`.
// Source: agent/runtime-plugin/skills/*/SKILL.md, agent/agents/*/config.yaml, PRIMARY_SOURCE_TOOLS, PLATFORM_FEATURES.

export interface CapabilitySkill {
  name: string;
  description: string;
  category: string;
}
export interface CapabilityProfile {
  name: string;
  role: string;
}
export interface CapabilityTool {
  name: string;
  summary: string;
}
export interface CapabilityFeature {
  name: string;
  summary: string;
  status: string;
}
export interface AssistantQuickAction {
  action: string;
  label: string;
  prompt: string;
  tools: string[];
}
export interface AssistantSurfaceEntry {
  pageType: string;
  routes: string[];
  quickActions: AssistantQuickAction[];
}
export interface CapabilityCatalog {
  skills: CapabilitySkill[];
  profiles: CapabilityProfile[];
  tools: CapabilityTool[];
  features: CapabilityFeature[];
  assistantSurface?: AssistantSurfaceEntry[];
}

export const CAPABILITY_CATALOG: CapabilityCatalog = {
  "skills": [
    {
      "name": "abstain-or-escalate",
      "description": "Use when a claim, relation, evidence snippet, or report line has no verifiable source — decide between refusing, escalating, or surfacing the disagreement rather than guessing. Runs after `grounded-answer` step 3 returns no usable source.",
      "category": "Critique & rigor"
    },
    {
      "name": "analysis-of-competing-hypotheses",
      "description": "Use when a question has several plausible explanations and the wrong pick is costly — adoption stalls, competitive shifts, unexplained failures, surprising signals. Runs Heuer's ACH — enumerate hypotheses, score evidence C/N/I/NA, favour fewest inconsistencies. For stress-testing an already-chosen plan use `premortem-analysis` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "analyze-patent-claims",
      "description": "Use for one patent filing or granted patent — \"US11234567\", \"EP3456789B1\", PCT/WIPO application, \"patent-pending\", freedom-to-operate, prior art, IPC/CPC code. Parses independent and dependent claims into a structured PatentEvent. For assignee concentration and white space across many filings use `read-patent-landscape` instead.",
      "category": "Domain checks"
    },
    {
      "name": "analyze-release-notes",
      "description": "Use for a release note, changelog, or version announcement — \"v2.4 released\", semver bump, \"breaking changes\", deprecation notice, or a CVE alongside a version. Parses it into a structured ReleaseEvent and grades signal strength for graph ingestion.",
      "category": "Domain checks"
    },
    {
      "name": "apply-hype-cycle",
      "description": "Use for \"is X overhyped?\", \"peak hype?\", \"past the trough?\", \"Gartner Hype Cycle for …\", \"adoption stage of X\", \"is this a fad?\". Places a technology on Gartner's five stages from observable indicators, plus a years-to-plateau estimate. For one dated prediction use `foresight` instead; for branching futures use `scenario-planning` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "assess-research-momentum",
      "description": "Use for \"is research on X heating up?\", \"is this a hot area?\", \"publication trend for X\", \"is the field maturing?\". Reads a `searchPapers` result set into a momentum signal — publication S-curve, citation velocity, author concentration, research-front vs mature.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "assess-study-bias",
      "description": "Use to evaluate a clinical trial, empirical study, benchmark comparison, or published experiment for methodological weakness — \"is this study reliable?\", \"assess bias in …\". Applies the Cochrane RoB-2 five domains — selection, performance, detection, attrition, reporting.",
      "category": "Critique & rigor"
    },
    {
      "name": "bayesian-update",
      "description": "Use to revise a belief in light of new evidence rather than treating new data as decisive — \"does this change my mind?\", \"how much should this move my estimate?\", \"update my prior\", \"posterior probability\", \"is this signal strong enough to act on?\". A transparent Bayes-factor update — state the prior, assess evidence likelihood under each hypothesis, combine into a posterior. Guards against base-rate neglect.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "benchmark-model-claims",
      "description": "Use when a vendor, paper, or release claims performance — \"X% on HumanEval\", \"outperforms GPT-5\", \"SOTA on MMLU\", \"3× faster than competitor\", leaderboard entries. Checks baseline freezing, contamination risk, seed averaging, evaluator blinding, and metric cherry-picking; emits a ReliabilityScore 0–5 with risk tags.",
      "category": "Critique & rigor"
    },
    {
      "name": "brier-score-calibration",
      "description": "Use to score a prediction once its outcome is known, or to grade a set of probabilistic forecasts — \"how accurate was that forecast?\", \"score my predictions\", \"was I overconfident?\", \"calibration check\", \"Brier score\". Computes Brier's strictly-proper score and decomposes it into reliability and resolution. Closes the loop on `foresight`, which makes dated predictions that nothing currently scores.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "cheapest-experiment",
      "description": "Use when a brief contains recommendations or a next-steps section — \"what should we invest in?\", \"should we pilot X?\", \"should we acquire Y?\". Forces every recommendation to name the smallest validating test, its cost and duration, and an explicit pass/fail decision rule.",
      "category": "Critique & rigor"
    },
    {
      "name": "chemistry-claim-check",
      "description": "Use when a chemistry or biotech signal, patent, or paper states a molecular claim in prose — a compound name with a formula (\"caffeine, C8H10N4O2\"), a molecular weight, or a \"drug-like\"/\"orally bioavailable\" assertion. Checks name-vs-formula consistency, impossible valences, MW plausibility, and Lipinski rule-of-five. For a SMILES string use `smiles-sanity-check` instead.",
      "category": "Domain checks"
    },
    {
      "name": "cite-ieee",
      "description": "Use when a report, research document, or long-form response carries three or more cited sources. Converts URLs, DOIs, arXiv IDs, paper titles, filings, and news articles into IEEE numbered-bracket inline citations plus a numbered References section.",
      "category": "Research & evidence"
    },
    {
      "name": "claim-provenance",
      "description": "Use when a brief or report contains fact-claims — numbers (\"$6.25B market\", \"24.8% CAGR\", \"60% YoY\"), forward-looking projections, or any sentence a reader might act on. Tags each with `[validated, <source>]` or `[assumption, retire-by <milestone>]` per Discovery-Driven Planning.",
      "category": "Research & evidence"
    },
    {
      "name": "critique-report",
      "description": "Use after a report or brief is drafted and before it reaches a user. Runs a 10-point structural self-review — question answered, evidence sourced, anti-patterns avoided, reproducible, confidence honest — plus three conditional innovation-practice points. For a single headline claim use `red-team-claim` instead.",
      "category": "Critique & rigor"
    },
    {
      "name": "cynefin-classification",
      "description": "Use at the start of a strategic brief that recommends action under uncertainty — \"what should we do about X?\", \"how do we navigate this market?\", \"what's our move in {emerging area}?\". Opens the brief with the decision domain (Clear / Complicated / Complex / Chaotic per Snowden) and its matching decision mode.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "decompose-research-question",
      "description": "Use when a question is too large, vague, or multi-part to answer directly — \"what's the future of X?\", \"analyze the {broad domain}\", \"compare all the Y\", \"help me understand Z\". Breaks it into a tree of independently answerable sub-questions that recombine.",
      "category": "Research & evidence"
    },
    {
      "name": "design-pass",
      "description": "Use when creating a visual report with charts or infographics. Establishes and enforces ONE design brief — theme, brand-exact palette, typography — across every chart, every infographic, and the report HTML. Two paths — CONCEPTION up front, and REVIEW before `publishReport`.",
      "category": "Reporting & radar"
    },
    {
      "name": "detect-funding-round",
      "description": "Use for a capital raise — \"Series A/B/C/D\", \"seed round\", \"raised $X million/billion\", \"closed a funding round\", \"announces financing\", \"valued at $X\". Parses it into a structured FundingEvent — amount, stage, date, lead investor, participants, post-money valuation.",
      "category": "Domain checks"
    },
    {
      "name": "detect-ma-event",
      "description": "Use for a transaction — \"acquired\", \"merger\", \"buyout\", \"takeover\", \"all-cash deal\", \"stock swap\", \"go-private\", \"carve-out\", \"definitive agreement\". Parses it into a structured MAEvent — acquirer, target, consideration, deal value, close, jurisdictions, termination fee — and flags deal-structure risk.",
      "category": "Domain checks"
    },
    {
      "name": "discover-relations",
      "description": "Use when finding evidence-backed connections between entities for human review. Proposes candidates with honest per-relation evidence and never auto-applies. For an exact current user directive naming both entities use the curated `createRelation` path instead.",
      "category": "Reporting & radar"
    },
    {
      "name": "estimate-market-size",
      "description": "Use when sizing a market — \"how big is the X market?\", \"TAM / SAM / SOM for …\", \"multi-billion market\", \"expected to reach $X by Y\", \"market valued at\". Triangulates a top-down and a bottom-up estimate that must agree within an order of magnitude, else the claim is rejected as unsupported.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "evaluate-signal",
      "description": "Use when scoring a new signal for trust and relevance before triage. Grades source reliability, data completeness, and corroboration into an overall trust score with an explicit triage decision.",
      "category": "Reporting & radar"
    },
    {
      "name": "evolution-stage",
      "description": "Use when a brief names technologies, capabilities, or vendor categories — tech comparisons, ecosystem maps, buy-vs-build matrices, radar landscape reports. Tags each with a Wardley evolution stage (Genesis / Custom-built / Product / Commodity) plus an evidence-anchored rationale. For empirical readiness use `score-technology-readiness` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "five-forces-analysis",
      "description": "Use when evaluating industry structure — \"how attractive is the X market?\", \"what are the competitive dynamics?\", \"barriers to entry\", \"supplier power\", \"buyer power\", \"threat of substitutes\". Applies Porter's Five Forces to industry-level profitability drivers. For firm-level placement use `position-competitor` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "foresight",
      "description": "Use for \"when will X happen?\", \"is this accelerating or stalling?\", \"what should we watch?\", \"by what date…?\" — a dated prediction about one technology, trend, or market shift. Names the prediction, accelerants, blockers, weak signals to monitor, kill-signals, and a review horizon. For branching futures use `scenario-planning` instead; to score the prediction once resolved use `brier-score-calibration` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "generate-radar-report",
      "description": "Use when creating a radar landscape or strategic report. Gathers placements by ring and quadrant, identifies movements against the previous period, renders the radar figure inline, and ships through the draft-then-publish path.",
      "category": "Reporting & radar"
    },
    {
      "name": "graph-as-instrument",
      "description": "Use before answering a question the knowledge graph could answer better than recall — \"what changed on my radar?\", \"which claims are contradicted?\", \"what are we missing?\", \"where are things converging?\", \"what should I look at next?\". Opens with structure, gaps, temporal deltas, and claim health rather than a web search. For a single factual lookup use `grounded-answer` instead.",
      "category": "Research & evidence"
    },
    {
      "name": "grounded-answer",
      "description": "Use before any factual answer that reaches a user, is saved to a stored record, enters a report, or influences a decision. Runs the four-step Chain-of-Verification cycle — draft, plan verification questions, answer them independently against graph and web sources, then revise. Skip for turns with no factual claims.",
      "category": "Research & evidence"
    },
    {
      "name": "grounded-fact-check",
      "description": "Use before publishing a report that states load-bearing specifics — vendor and product numbers, benchmark scores, market figures, dates, named standards, \"X overtook Y in YYYY\", percentages a reader would act on. Verifies each value against a grounded search and reconciles the draft. For identifier format validation use `verify-citations` instead.",
      "category": "Research & evidence"
    },
    {
      "name": "jtbd-framing",
      "description": "Use when a brief compares technologies, vendors, or products — \"which of these should we adopt?\", \"how do these vendors compare?\", \"buy vs build\", \"ecosystem of {category}\". Produces a verb-led outcome-driven job statement per technology, the competing solutions including non-consumption, and the struggling moment.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "key-assumptions-check",
      "description": "Use before relying on a conclusion that rests on unexamined premises — \"what are we assuming here?\", \"what would have to be true for X to hold?\", \"stress-test our reasoning\". Heuer's Key Assumptions Check — enumerate the premises a conclusion depends on, rate each for sensitivity and grounding, then re-source or kill the ones that are both sensitive and ungrounded. For comparing whole rival hypotheses use `analysis-of-competing-hypotheses` instead.",
      "category": "Critique & rigor"
    },
    {
      "name": "oss-project-health",
      "description": "Use when assessing an open-source project's viability — \"is this project maintained?\", \"bus factor\", \"is it dying?\", \"should we depend on this?\". Reads `searchOssHealth` signals — release cadence, contributor concentration, issue latency — into a maintenance verdict.",
      "category": "Research & evidence"
    },
    {
      "name": "position-competitor",
      "description": "Use when placing a company or technology on a 2D competitive landscape — \"where does X sit vs Y?\", \"competitive positioning\", \"market map\", \"who are the leaders in category Z?\", \"magic quadrant for …\". Axis selection, evidence-based placement, whitespace, orthogonality check. For industry structure use `five-forces-analysis` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "premortem-analysis",
      "description": "Use before committing to a strategy, recommendation, roadmap, or investment — \"should we invest in X?\", \"is this the right strategy?\", \"what could go wrong?\", \"before we commit to this plan…\". Kahneman's premortem — assume it failed 12 months out, work backwards to failure modes, likelihoods, and mitigations. For choosing between rival explanations use `analysis-of-competing-hypotheses` instead.",
      "category": "Critique & rigor"
    },
    {
      "name": "pyramid-principle",
      "description": "Use to structure a persuasive analytical argument or document — \"structure this report\", \"make this argument land\", \"governing thought\", \"Minto pyramid\", \"execs keep asking what the point is\". Minto's Pyramid — lead with one governing thought, support it with a MECE group of arguments, each backed by evidence, so the document reads top-down in 30 seconds or 30 minutes. For a one-page decision brief use `write-srl-brief` instead.",
      "category": "Reporting & radar"
    },
    {
      "name": "quantitative-sanity-check",
      "description": "Use when a document, signal, or report states numbers that should be internally consistent — CAGR from $A to $B by a year, revenue/users/price triples, \"improved 5%\" (percent or percentage points?), survivorship framing, Fermi-style headline figures. Recomputes the source's own arithmetic. Internal consistency only — no external sources.",
      "category": "Critique & rigor"
    },
    {
      "name": "rate-source-admiralty",
      "description": "Use to record how trustworthy a source is — an incoming signal, an evidence snippet, a report citation, a claim entering the knowledge graph. Assigns a two-axis NATO Admiralty grade (A1–F6) covering source reliability and information credibility. For a first-look check on an unfamiliar web source use `sift-source-check` instead; for verifying a specific stated value use `grounded-fact-check` instead.",
      "category": "Research & evidence"
    },
    {
      "name": "read-patent-landscape",
      "description": "Use when reading a cluster of patents for competitive or white-space signal — \"who owns the IP around X?\", \"patent landscape for X\", \"is this space getting crowded?\", \"where's the white space?\". Reads assignee concentration, family growth, CPC clustering, and filing velocity. For one filing's claims use `analyze-patent-claims` instead.",
      "category": "Domain checks"
    },
    {
      "name": "red-team-claim",
      "description": "Use before a report's headline claim reaches a user — \"our conclusion is {X}\", \"the key takeaway is {Y}\". Adversarial review — what a skeptical reviewer, a competitor's analyst, or a regulator would say against it. Names attack vectors and forces a fix, a hedge, or a retraction. For whole-report structure use `critique-report` instead.",
      "category": "Critique & rigor"
    },
    {
      "name": "research-company",
      "description": "Use when discovering or enriching a company entity. Checks the graph first, researches primary sources, creates or updates the entity, and proposes evidence-backed relations for human review.",
      "category": "Research & evidence"
    },
    {
      "name": "research-technology",
      "description": "Use when discovering or enriching a technology entity. Checks the graph, gathers academic and patent evidence, assesses readiness and key players, then creates or updates the entity and proposes a radar placement.",
      "category": "Research & evidence"
    },
    {
      "name": "scenario-planning",
      "description": "Use when the future is genuinely uncertain and a single-point forecast is inadequate — \"what could happen to X over the next 3–5 years?\", \"plausible futures\", \"2x2 scenarios\", \"alternative futures\", \"driver analysis\". Shell's method — two critical uncertainties, a 2×2 matrix, each future narrated with triggers. For one dated prediction use `foresight` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "score-technology-readiness",
      "description": "Use when placing a technology on a capability ring or answering \"how ready is X?\", \"is this production-grade?\", \"can I deploy this?\", \"what TRL is it?\", \"is this proven at scale?\". Applies NASA's 9-level TRL scale adapted for software and AI, with the evidence required per level. For strategic-method fit use `evolution-stage` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "sift-source-check",
      "description": "Use before trusting, citing, or acting on a web source you do not already know — \"is this source legit?\", \"can I trust this article?\", \"verify this link\", \"is this real?\". Runs SIFT (Caulfield) — Stop, Investigate the source, Find better coverage, Trace claims to the original — by lateral search rather than by reading the suspicious page. For grading a source you have already accepted use `rate-source-admiralty` instead.",
      "category": "Research & evidence"
    },
    {
      "name": "smiles-sanity-check",
      "description": "Use whenever a SMILES string appears — in a prompt about a chemistry or biotech signal, in a patent claim, in a paper's methods section, or in a structured field on a Technology or Signal. Structural syntax check — balanced brackets, valid atoms, valid bond and ring tokens — to catch copy-paste corruption and hallucinated structures. Not chemistry semantics.",
      "category": "Domain checks"
    },
    {
      "name": "steelman-argument",
      "description": "Use before refuting an opposing view, to be sure you are attacking its strongest form — \"steelman the opposing case\", \"strongest argument for X\", \"am I strawmanning?\", \"the best case against my position\". Builds the most charitable version of the opposing argument to the standard its actual proponents would endorse. For attacking your own headline claim use `red-team-claim` instead.",
      "category": "Critique & rigor"
    },
    {
      "name": "systematic-review",
      "description": "Use for a comprehensive, reproducible survey of the literature or signal corpus — \"what does the research say about X?\", \"comprehensive review of …\", \"systematic review\", \"what's the evidence base for …\". Structures the process around PRISMA 2020 with an audit trail of why each source was included or excluded.",
      "category": "Research & evidence"
    },
    {
      "name": "test-significance",
      "description": "Use when a claim rests on \"X is significantly better/bigger/faster than Y\" — \"Model A scored 87% vs Model B's 85%\", \"12% more clicks\", \"the new variant improved conversion\". Checks whether the gap is meaningful given sample size and variance, and names the statistic to report.",
      "category": "Critique & rigor"
    },
    {
      "name": "three-horizons",
      "description": "Use when a brief proposes a portfolio of bets, capabilities, or technologies — investment briefs, transformation roadmaps, \"where should we focus?\", \"what's our portfolio across the next 5 years?\". Tags every bet H1 (0–12 months), H2 (1–3 years), or H3 (3–5 years) with a time-to-revenue-impact estimate.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "triangulate-sources",
      "description": "Use when a claim warrants more than one source — a relation at confidence ≥ 75, an executive-summary claim, a signal flagged for auto-apply, an assertion that will propagate through graph traversals. Requires two independent corroborating sources, grades each, and emits a combined confidence with explicit source diversity. For verifying one stated value use `grounded-fact-check` instead.",
      "category": "Research & evidence"
    },
    {
      "name": "verify-citations",
      "description": "Use after `cite-ieee` produces a References section, or when a report contains DOIs, arXiv IDs, or URLs to check before publishing. Validates each identifier against its canonical format and surfaces ones that should be replaced. For checking whether a stated value is true use `grounded-fact-check` instead.",
      "category": "Research & evidence"
    },
    {
      "name": "verify-entity",
      "description": "Use when validating an entity's data quality and freshness. Checks staleness, cross-references current sources, records a verification result, and flags disputes for human review.",
      "category": "Reporting & radar"
    },
    {
      "name": "weak-signal-triage",
      "description": "Use when a signal is sparse but potentially important — one source, an unknown actor, an anomaly that does not fit current models, \"is this noise or early?\", \"too early to tell\". Scores amplitude and potential impact as two separate axes so a genuine weak signal is not discarded for being sparse. For an already well-sourced signal use `evaluate-signal` instead.",
      "category": "Analysis & forecasting"
    },
    {
      "name": "write-imrad-report",
      "description": "Use for a scientific or research-style long-form report — a technical whitepaper, an empirical finding document, a landscape analysis needing academic rigor. Structures it as IMRAD (Introduction / Methods / Results / Discussion) with an optional executive summary and references. For a one-page decision brief use `write-srl-brief` instead.",
      "category": "Reporting & radar"
    },
    {
      "name": "write-srl-brief",
      "description": "Use for a short decision-oriented briefing of one page or less — \"give me a 1-pager on X\", \"brief me on Y\", \"SBAR\", \"executive summary of Z\", \"crisp summary\". Structures it as Situation, Background, Assessment, Recommendation with strict length caps and a mandatory confidence tag. For an academic-shaped report use `write-imrad-report` instead; for the argument structure inside either use `pyramid-principle` instead.",
      "category": "Reporting & radar"
    }
  ],
  "profiles": [
    {
      "name": "creator",
      "role": "Generates professional HTML reports and shareable artifacts from graph knowledge"
    },
    {
      "name": "curator",
      "role": "Maintains data quality — fills gaps, fixes inconsistencies, enriches incomplete entities"
    },
    {
      "name": "defense-minister",
      "role": "Data quality verifier — continuous entity validation, staleness detection, and fact-checking against web sources"
    },
    {
      "name": "evaluator",
      "role": "Scores technologies, assesses maturity (TRL), and validates claims with evidence"
    },
    {
      "name": "linker",
      "role": "Discovers and validates relationships between entities in the knowledge graph"
    },
    {
      "name": "scout",
      "role": "Discovers new signals, companies, and technologies through web research, browser automation, and academic sources"
    },
    {
      "name": "strategist",
      "role": "Analyzes patterns, connects trends to strategy, generates proactive insights"
    }
  ],
  "tools": [
    {
      "name": "searchPapers",
      "summary": "Search real academic literature across OpenAlex, Crossref, and Semantic Scholar — three keyless, public scholarly indexes covering peer-reviewed papers, prepri…"
    },
    {
      "name": "resolveOpenAccess",
      "summary": "Resolve the open-access status and free full-text PDF location for a paper's DOI, via Unpaywall — the canonical public open-access database."
    },
    {
      "name": "searchHackerNews",
      "summary": "Search Hacker News (stories, Show HN, Ask HN, comments) via the keyless HN Algolia API — a real-time pulse on what the developer/tech community is discussing r…"
    },
    {
      "name": "searchSecFilings",
      "summary": "Search real SEC filings (10-K, 10-Q, 8-K, S-1, etc.) via the SEC EDGAR full-text search API — the authoritative, keyless, public source for US public-company d…"
    },
    {
      "name": "searchOssHealth",
      "summary": "Look up open-source repository health metrics (stars, contributors, last commit, maintenance score) for a GitHub repo via the keyless Ecosyste.ms API."
    },
    {
      "name": "searchPatents",
      "summary": "Search the patent landscape for a topic, keyword, or assignee via the keyless Google Patents search API — real filings with assignees and filing dates, plus th…"
    }
  ],
  "features": [
    {
      "name": "research-missions",
      "summary": "Multi-agent research missions (kind 'research') run by the mission profiles — dispatched from chat via startMission; produce reports, verdicts, and graph updates tracked live on the Agent Runs page.",
      "status": "live"
    },
    {
      "name": "build-missions",
      "summary": "Experimental sandboxed prototyping. The path is default-off and excluded from the qualified v0.1 surface because its sandbox image and external executable bundle are not fully pinned. Do not use it for sensitive or reproducible work.",
      "status": "experimental; default-off; not qualified or supported in v0.1"
    },
    {
      "name": "limitless-build-mode",
      "summary": "Experimental higher-budget build mode layered on the unqualified build sandbox. It is default-off and outside the supported v0.1 prototype surface.",
      "status": "experimental; default-off; not qualified or supported in v0.1"
    },
    {
      "name": "technology-evaluations",
      "summary": "Experimental hands-on evaluation implemented through the unqualified build sandbox. Ordinary assessment and radar triage remain available without enabling this path.",
      "status": "experimental; default-off; not qualified or supported in v0.1"
    }
  ],
  "assistantSurface": [
    {
      "pageType": "dashboard",
      "routes": [
        "/dashboard"
      ],
      "quickActions": [
        {
          "action": "show_metrics",
          "label": "Show Metrics",
          "prompt": "Show me the current dashboard metrics",
          "tools": []
        },
        {
          "action": "recent_activity",
          "label": "Recent Activity",
          "prompt": "What's the recent activity in the platform?",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "radar",
      "routes": [
        "/radar",
        "/visualizations/radar"
      ],
      "quickActions": [
        {
          "action": "analyze_trends",
          "label": "Analyze Trends",
          "prompt": "Analyze the current technology trends on the radar",
          "tools": []
        },
        {
          "action": "suggest_entries",
          "label": "Suggest Entries",
          "prompt": "Suggest new entries for the radar",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "relations-graph",
      "routes": [
        "/triage/relations"
      ],
      "quickActions": [
        {
          "action": "explain_graph",
          "label": "Explain Graph",
          "prompt": "Explain the relationships shown in this graph",
          "tools": []
        },
        {
          "action": "find_clusters",
          "label": "Find Clusters",
          "prompt": "Find clusters of related entities in the graph",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "library",
      "routes": [
        "/library"
      ],
      "quickActions": [
        {
          "action": "filter_help",
          "label": "Filter Help",
          "prompt": "How can I filter the items in this list?",
          "tools": []
        },
        {
          "action": "bulk_actions",
          "label": "Bulk Actions",
          "prompt": "What bulk actions can I perform here?",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "entity-list",
      "routes": [
        "/library/companies",
        "/library/documents",
        "/library/initiatives",
        "/library/org-units",
        "/library/pain-points",
        "/library/prototypes",
        "/library/strategies",
        "/library/technologies",
        "/library/use-cases"
      ],
      "quickActions": [
        {
          "action": "filter_help",
          "label": "Filter Help",
          "prompt": "How can I filter the items in this list?",
          "tools": []
        },
        {
          "action": "bulk_actions",
          "label": "Bulk Actions",
          "prompt": "What bulk actions can I perform here?",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "entity-detail",
      "routes": [],
      "quickActions": [
        {
          "action": "research_entity",
          "label": "Research",
          "prompt": "Research this entity",
          "tools": []
        },
        {
          "action": "find_relations",
          "label": "Find Relations",
          "prompt": "Find related entities",
          "tools": []
        },
        {
          "action": "summarize_entity",
          "label": "Summarize",
          "prompt": "Summarize this entity",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "signals",
      "routes": [],
      "quickActions": [
        {
          "action": "explain_signals",
          "label": "Explain Signals",
          "prompt": "Explain the current signals in the triage queue",
          "tools": []
        },
        {
          "action": "bulk_approve",
          "label": "Approve High",
          "prompt": "Approve all high-confidence signals",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "signal-triage",
      "routes": [
        "/triage/signals",
        "/triage/signals/[id]"
      ],
      "quickActions": [
        {
          "action": "explain_signals",
          "label": "Explain Signals",
          "prompt": "Explain the current signals in the triage queue",
          "tools": []
        },
        {
          "action": "bulk_approve",
          "label": "Approve High",
          "prompt": "Approve all high-confidence signals",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "agents",
      "routes": [
        "/agents/jobs",
        "/agents/runs",
        "/agents/runs/[id]"
      ],
      "quickActions": [
        {
          "action": "agent_help",
          "label": "Agent Help",
          "prompt": "How do AI agents work in this platform?",
          "tools": []
        },
        {
          "action": "create_agent",
          "label": "Create Agent",
          "prompt": "Help me create a new AI agent",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "agent-create",
      "routes": [],
      "quickActions": [
        {
          "action": "wizard_help",
          "label": "Wizard Help",
          "prompt": "Help me use the agent creation wizard",
          "tools": []
        },
        {
          "action": "task_suggestions",
          "label": "Task Ideas",
          "prompt": "Suggest task ideas for a new agent",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "agent-monitor",
      "routes": [],
      "quickActions": [
        {
          "action": "agent_status",
          "label": "Agent Status",
          "prompt": "What is the current status of my agents?",
          "tools": []
        },
        {
          "action": "troubleshoot_agent",
          "label": "Troubleshoot",
          "prompt": "Help me troubleshoot an agent issue",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "agent-settings",
      "routes": [],
      "quickActions": [
        {
          "action": "config_help",
          "label": "Config Help",
          "prompt": "Explain the agent configuration options",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "settings",
      "routes": [
        "/settings"
      ],
      "quickActions": [
        {
          "action": "settings_help",
          "label": "Settings Help",
          "prompt": "Explain the available settings",
          "tools": []
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "reports",
      "routes": [
        "/reports",
        "/reports/[id]"
      ],
      "quickActions": [
        {
          "action": "list_reports",
          "label": "List Reports",
          "prompt": "List my recent reports",
          "tools": [
            "listReports",
            "getReportById"
          ]
        },
        {
          "action": "draft_report",
          "label": "Draft Report",
          "prompt": "Draft a new report summarizing recent findings",
          "tools": [
            "getArtifactFindings",
            "startMission"
          ]
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "artifacts",
      "routes": [
        "/artifacts",
        "/artifacts/[id]"
      ],
      "quickActions": [
        {
          "action": "list_missions",
          "label": "Recent Missions",
          "prompt": "Show my recent agent missions and their artifacts",
          "tools": [
            "listUserMissions",
            "getMissionStatus"
          ]
        },
        {
          "action": "artifact_findings",
          "label": "Latest Findings",
          "prompt": "What did my recent evaluation artifacts find?",
          "tools": [
            "getArtifactFindings"
          ]
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "infographics",
      "routes": [
        "/infographics",
        "/infographics/[id]"
      ],
      "quickActions": [
        {
          "action": "generate_infographic",
          "label": "New Infographic",
          "prompt": "Generate a new infographic from my radar data",
          "tools": [
            "listRadars",
            "getRadarDetails",
            "generateInfographic"
          ]
        },
        {
          "action": "visualize_data",
          "label": "Visualize Data",
          "prompt": "Create a data visualization from my current data",
          "tools": [
            "listRadars",
            "getRadarDetails",
            "generateVisualization"
          ]
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "knowledge-graph",
      "routes": [
        "/visualizations/graph"
      ],
      "quickActions": [
        {
          "action": "explain_graph",
          "label": "Explain Graph",
          "prompt": "Explain the relationships shown in this graph",
          "tools": []
        },
        {
          "action": "community_reports",
          "label": "Communities",
          "prompt": "Summarize the communities in the knowledge graph",
          "tools": [
            "getCommunityReports",
            "listCommunityClusters"
          ]
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "assessment-triage",
      "routes": [
        "/triage/assessment",
        "/triage/assessment/[id]"
      ],
      "quickActions": [
        {
          "action": "pending_assessments",
          "label": "Pending Items",
          "prompt": "What assessments are pending my review?",
          "tools": [
            "getPendingProposals"
          ]
        },
        {
          "action": "approve_top_assessment",
          "label": "Approve Top",
          "prompt": "Approve the top pending assessment",
          "tools": [
            "getPendingProposals",
            "approveAssessment"
          ]
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    },
    {
      "pageType": "insights",
      "routes": [
        "/triage/insights",
        "/triage/insights/[id]"
      ],
      "quickActions": [
        {
          "action": "proactive_insights",
          "label": "My Insights",
          "prompt": "What proactive insights do you have for me?",
          "tools": [
            "getProactiveInsights"
          ]
        },
        {
          "action": "personalized_recommendations",
          "label": "What Next",
          "prompt": "What should I look at next based on my radar?",
          "tools": [
            "listRadars",
            "getRadarDetails",
            "getPersonalizedRecommendations"
          ]
        },
        {
          "action": "navigation_help",
          "label": "Navigate",
          "prompt": "Help me navigate the platform",
          "tools": []
        }
      ]
    }
  ]
};
