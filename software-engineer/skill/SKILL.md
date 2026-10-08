---
name: harness
description: "Trigger: /harness init, instalar el harness en un proyecto, preparar el proyecto para los agentes. Detects the project by script, proposes the harness profile, AGENTS.md, agents and skill/MCP recommendations, and writes them only after approval."
license: Apache-2.0
metadata:
  author: ebGiraldo
  version: "0.1"
---

## Activation Contract

`/harness init` prepares the **current project** for the harness. Other arguments: `/harness` with no args or an unknown one → print the usage below and stop.

```
/harness init            detect, show the plan, ask, then write (this skill)
/harness init --force    same, replacing an existing profile / differing agents
/harness init --sdd open|all|none   which previous SDD history to copy in Engram (default: all)
```

The CLI is `node ~/Projects/ia-tools/harnesses/software-engineer/bin/harness.mjs` (call it `H`). Detection is done by that script, never by reading the repo yourself: you interpret its summary. Design and decisions: `~/Projects/ia-tools/private/harness-notes.md` (§5, §16).

## Steps (`/harness init`)

1. Check the working directory is the project root (has a manifest or `.git`). If not, say so and stop.
2. Run `H init` (dry-run is the default) and read its JSON. Do not write anything yet.
3. Show a summary of **at most 14 lines**: stack and evidence highlights, the proposed **gate** and what it does not cover, suggested **T2 paths** and **UI paths**, git branches, recommended MCPs, the **skills assigned to each agent** (`agentSkills`) and any unassigned, **previous harness traces** (`legacy`: guide, skills-lock, specs/decisions, conflicting agents) and the **Engram SDD history** found (`sdd`: observations, changes, archived), and the files it would write.
4. Ask **one question at a time** and stop after each; never assume the answer. Ask only what applies:
   1. If a guide section is flagged as a previous workflow (`flow`): keep, replace or merge it with the harness flow? Record the answer in `.harness/migration.md`; never edit the original guide.
   2. If `sdd.found > 0`: copy `all` the history, only the `open` changes, or `none`? Recommend `all` (copy, reversible, originals untouched).
   3. The T2 paths (migrations, auth, billing, infra): are they right? Offer to edit them. Apply edits to the JSON before writing.
   4. If the gate is missing or empty: what is the single verification command?
   5. Finally: "Write this?"
5. On a yes, run `H init --apply --sdd <choice>` (add `--force` only if the user asked). It writes `.harness/profile.json` (skills adopted from `skills-lock.json`, project conventions), `.harness/backlog.json`, `.harness/migration.md`, `AGENTS.md` (or `.harness/AGENTS.proposed.md` with existing rules as pointers if an `AGENTS.md`/`CLAUDE.md` exists, never overwritten), `.claude/agents/*.md` (never overwrites a differing file without `--force`) and copies `sdd/*` to `harness/*` in Engram. `engram import` is **not idempotent**, so the script checks what exists first: re-running copies nothing twice.
   Each agent file gets a generated **project block** (stack, gate, T2/UI paths, conventions, rules as pointers, and the skills it may use) between `harness:project` markers; text outside the markers is the user's and is never touched. Edits to a hand-rewritten agent file are skipped, not overwritten.
   It also creates the `/planner` command (`.claude/skills/planner/SKILL.md`, generated, points to the agent file; more roles via `slashRoles` in the profile). Tell the user: `/planner <what you want>` starts the planning session.
   It also writes `.harness/recommendations.md` (skills per agent, MCPs with reason, cost and alternative).
   If the user changed tiers, gate or `agents.<role>.skills` in `.harness/profile.json`, run `H agents sync` (add `--reassign` only to recompute the skill split from scratch) to refresh the agent blocks.
6. Save a profile summary in Engram: `mem_save` with `topic_key: harness/init/<project>`, `capture_prompt: false`. Contents: stack, gate, tiers, branches (no secrets).
7. Report in ≤10 lines what was written, what was skipped and why, **the skills each agent got**, the **MCPs recommended (not installed)** with their alternative, and what is still missing. Point to `.harness/recommendations.md` and `.harness/migration.md`. Do not commit; the user decides what to commit.

## Hard Rules

- Dry-run first, always. Nothing is written before the user says yes.
- Never install skills, MCPs or dependencies. Only recommend (each MCP costs tokens at every session start).
- Nothing previous is deleted or moved: the Engram history is **copied** (originals under `sdd/` stay), specs/decisions are registered where they are, existing agents with the same name are kept and reported as conflicts.
- Never overwrite an existing `AGENTS.md`, `CLAUDE.md`, `.claude/agents/*.md` or `profile.json` without `--force` and an explicit request.
- No commit, no push, no `.gitignore` edits. Whether `.harness/` is versioned is the user's call (open question in the notes).
- Detection evidence comes from the script output; cite file and line from it, do not invent.
- Answer in the user's language.
