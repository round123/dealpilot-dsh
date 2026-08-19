# DealPilot Workspace

Welcome to your DealPilot workspace. This directory is the authoritative source for all your sales data. It is managed by the DealPilot DSH agent, but you can also open and edit these files directly — they are plain Markdown with YAML frontmatter.

## Getting Started

1. Place customer lists, prospect spreadsheets, or exhibition contact sheets in `sources/inbox/`.
2. In the DSH chat, say: "Import my customers from sources/inbox/"
3. The agent will parse the files, create customer profiles, and populate the `knowledge/` directory.

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
```

## File Format

Every concept file uses YAML frontmatter + Markdown body:

```markdown
---
title: Acme Corp
status: active
source_category: exhibition
---
# Profile
Description of the customer...
```

## Important

- Do NOT move or rename files in `knowledge/` manually — references between files use relative paths.
- The `events/business-events.jsonl` is append-only — do not edit it.
- Git is recommended for version control: `git init && git add . && git commit -m "Initial workspace"`