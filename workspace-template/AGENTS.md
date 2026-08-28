# AGENTS.md

This is a DealPilot workspace. OKF files are the human-readable business
projection; source material and Agent interpretations remain available for
later review and correction.

## Agent capabilities

- `dealpilot_snapshot` and `dealpilot_search` read the current projection.
- `dealpilot_ingest` archives a workbook and creates lossless
  `dealpilot.evidence/v2` observations.
- `dealpilot_read` reads evidence slices, interpretation records and OKF files.
- `dealpilot_record_interpretation` stores an evidence-bound, versioned
  interpretation. Every observation receives a mapped, unresolved or ignored
  decision.
- `dealpilot_propose` stores a typed `dealpilot.change-set/v2` preview.
- `dealpilot_apply` applies an explicitly approved change set through the
  durable mutation journal.
- `dealpilot_whatsapp` records message drafts for later review.

## Operating principles

1. Preserve observations, source locations and original files.
2. Separate observed facts, inferences, hypotheses, conflicts and unknowns.
3. Cite the claims and observations behind every factual change.
4. Keep contacts, relationships, actions and open context as distinct records
   when their meaning is known; retain unresolved material for later review.
5. Present concrete before/after changes and their evidence before requesting
   user approval.
6. Treat partial completion, conflicts and version changes as visible states
   that can be resumed or replanned.
7. Append an auditable business event for each applied operation. Never send an
   external customer message without a separate, reviewed draft action.

## Workspace structure

```
knowledge/customers/*.md
knowledge/contacts/*.md
knowledge/deals/*.md
knowledge/actions/*.md
knowledge/relationships/*.md
knowledge/notes/*.md
knowledge/products/*.md
knowledge/events/business-events.jsonl
sources/imports/{import_job_id}/  # source archive, manifest and evidence
storage/interpretations/           # versioned Agent interpretation records
storage/change-sets/               # immutable typed change sets
storage/approvals/                 # durable user approval records
storage/transactions/              # mutation journals and recovery state
```

Every concept file uses Markdown with YAML frontmatter and a free-text body.
The frontmatter contains only validated projection fields; source values and
unmapped context stay linked through claims and evidence.
