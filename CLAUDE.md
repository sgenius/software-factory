# Software Factory — Project Brief

## Purpose
A generic, reusable multi-agent pipeline for producing and reviewing code —
applicable to a brand-new project or an update to an existing one. Optimized
for **code legibility** and **ease of human review**. Starts with a human
approving every change; automated review is added later once trust is
established.

## Core Requirements
- Separate agents for **planning**, **coding**, **testing**, and **review**.
- An **orchestrator** agent that loops the pipeline and enforces that goals
  are actually reached (not just that agents ran).
- Phase 1: human-in-the-middle at the review gate. Phase 2: automated review,
  with the human as fallback for low-confidence cases.
- Legibility is a first-class goal, not an afterthought — both the code the
  factory produces and the factory's own internals should be easy to follow.

## Architecture: Sequential Pipeline
Stages are inherently sequential, so this is a **pipeline**, not a
manager/worker fan-out: Planner → Coder → Tester → Reviewer, with the
Orchestrator driving the loop and holding the only end-to-end state.

### Orchestrator
- Implemented as an explicit **state machine**
  (`planning → coding → testing → review → human_gate → done/failed`),
  not an LLM improvising control flow.
- Passes **structured artifacts** (typed JSON, not chat history) between
  stages — this is also what keeps the pipeline itself legible/auditable.
- Enforces: max fix-review cycles before escalating to a human, a token/cost
  budget per task, and idempotent task IDs so a retried step can't
  double-execute.

### Planner
Input: a requirement/ticket. Output: a structured plan — task breakdown,
files to touch, acceptance criteria. This plan is the contract every
downstream agent works against.

### Coder
Input: the plan. Works on an isolated branch/worktree. Output: a diff.
Implements strictly against the plan — no unplanned scope creep.

### Tester
Input: the plan's acceptance criteria + the diff. Writes/runs tests, outputs
structured pass/fail (not prose). Kept separate from the Coder so it isn't
just confirming the Coder's own assumptions.

### Reviewer
Input: the diff + the legibility rubric (below). Output: structured findings
— `blocking` / `nit` / `question`, each tied to a specific file and line.

## Legibility Rubric
Write the rubric down as an actual checklist document
(`rubrics/legibility-default.md`) that both the Coder and Reviewer read —
concrete and falsifiable (max function length, no clever one-liners, match
existing file's patterns, naming conventions) rather than a vague "write
clean code" instruction.

## Human-in-the-Loop → Automation Path
1. **Now:** Reviewer posts findings; a human approves/rejects/requests
   changes. That decision is the actual merge gate.
2. **Later:** once enough human decisions are collected, the Reviewer
   auto-approves when findings are clean and confidence is high, and routes
   to a human only when it flags something or confidence is low.

## Repository Structure
```
software-factory/                  # this repo — versioned independently
├── agents/
│   ├── planner/system-prompt.md
│   ├── coder/system-prompt.md
│   ├── tester/system-prompt.md
│   └── reviewer/system-prompt.md
├── rubrics/
│   └── legibility-default.md      # overridable per project
├── schemas/                       # contracts between stages
│   ├── plan.schema.json
│   ├── review-finding.schema.json
│   └── task-state.schema.json
├── orchestrator/                  # state machine + guardrails
├── evals/
│   └── golden-tasks/
├── projects/                      # one small config file per target project
│   ├── <project-a>.yaml
│   └── <project-b>.yaml
└── workspace/                     # gitignored, ephemeral
    └── <task-id>/
        ├── repo/                  # checked-out target code lives ONLY here
        ├── plan.json
        ├── diff.patch
        ├── test-results.json
        └── review.json
```

## Applying the Factory to a Project (New or Existing)
- The factory never edits itself when working on a project — agents' file
  tool access is scoped only to `workspace/<task-id>/repo/`.
- **Existing project:** clone it (or `git worktree add` if local) into
  `workspace/<task-id>/repo/` for that run.
- **New project:** scaffold directly into that same path. The orchestrator
  doesn't need to distinguish "checkout" from "scaffold" — both just mean
  "populate the workspace before handing off to the Coder."
- The only thing that varies per project is `projects/<name>.yaml`: repo
  location, stack, rubric overrides, budget caps, human-approval policy.
- Later option: package the factory as an installable CLI so applying it to
  a project is `factory init` inside that project (drops a small
  `.factory.yaml`, or a `.claude/agents/*.md` folder if built on Claude Code
  subagents), with the heavy logic staying in the shared, independently
  upgraded package.

## Communication Protocol
Structured, typed messages between stages (task in, result out — validated
against the schemas above), not a shared mutable scratchpad. Easy to log,
replay, and test; keeps context/cost predictable.

## Reliability & Cost Guardrails
- Deterministic task IDs; every tool call safe to retry (idempotent).
- Bounded retries with backoff; circuit breaker per agent if it fails
  repeatedly in a short window.
- Cap what each stage passes to the next (summarized, not raw output) to
  avoid context bloat.
- Per-run and per-agent token budgets; tier models (cheap model for
  classification/routing, stronger model for Coder/Reviewer reasoning).
- A hard daily spend cap as a kill switch.

## Observability & Evals
- Structured log per model/tool call: task ID, agent, tokens, latency,
  status.
- A golden set of canonical tasks with known-good outcomes, run regularly;
  track pass rate, cost, and latency to catch regressions before they reach
  the human reviewer.

## Suggested Stack
- **Claude Code subagents** — good fit for building and iterating on this
  while dev-testing locally.
- **Claude Agent SDK** — for running the factory as a standalone,
  production system once it's stable.
- **LangGraph** — worth considering if the orchestrator needs more explicit
  graph control or durable human-approval checkpoints than the above give
  out of the box.

## First Milestones
1. Scaffold the repository structure above.
2. Write v0 system prompts for Planner, Coder, Tester, Reviewer.
3. Build the orchestrator state machine with a human gate at review.
4. Run one target project end-to-end, fully human-reviewed.
5. Add the eval harness and a first golden-task set.
6. Introduce confidence-threshold auto-approval at the review gate.
