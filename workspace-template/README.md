# DealPilot Workspace

This directory is the local sales workspace used by DealPilot. Original source
files and the Agent's interpretations stay available for rereading; the
Markdown files under `knowledge/` are the current, human-readable business
projection.

## Getting Started

1. Place a customer list, prospect spreadsheet, or other source material in
   `sources/inbox/`, or upload it from the DealPilot import view.
2. Ask the Agent to ingest the source and inspect the resulting evidence. This
   archives the original bytes and records every readable observation; it does
   not yet create or update a business object.
3. Ask the Agent to record an evidence-bound interpretation. Facts, inferences,
   hypotheses, conflicts, and unknowns remain distinct, and every observation
   receives a mapped, unresolved, or justified ignored status.
4. Review the typed before/after change-set. `dealpilot_apply` asks the host to
   present that exact preview; when you approve it, the same execution commits
   the selected operations. The durable approval record remains available for
   audit and recovery.

## Directory Structure

```
knowledge/
  customers/     ← One .md file per customer (YAML frontmatter + Markdown)
  deals/         ← One .md file per deal/opportunity
  actions/       ← One .md file per action/task
  contacts/      ← One .md file per contact person
  products/      ← One .md file per product
  events/        ← Business event log (JSONL, append-only)
  index.md       ← Knowledge index
  log.md         ← Change log

sources/
  inbox/         ← Drop files here for import
  imports/        ← Immutable source archives and evidence documents

storage/
  interpretations/ ← Versioned LLM interpretation records
  change-sets/     ← Immutable typed change-set previews
  proposals/       ← Session-bound proposal records
  approvals/       ← User approval artifacts bound to exact change sets
  transactions/    ← Recoverable mutation journals
  indexes/         ← Rebuildable query projections
```

## File Format

Every concept file uses YAML frontmatter + Markdown body. Frontmatter contains
only validated projection fields; source values, citations, unresolved context,
and correction history remain in linked claims/evidence or the body:

```markdown
---
title: Acme Corp
status: active
source_category: exhibition
---
# Profile
Observed facts and context...
```

## Important

- Treat `knowledge/` as a projection: make business changes through a typed
  change-set and explicit approval so evidence, events, and indexes stay
  traceable. Direct edits can be read, but are not an audited mutation.
- The `events/business-events.jsonl` file is append-only and is written by the
  mutation kernel.
- Git is recommended for version control: `git init && git add . && git commit -m "Initial workspace"`
- Correcting or rebuilding a projection never removes the original source or
  earlier interpretation artifacts.
