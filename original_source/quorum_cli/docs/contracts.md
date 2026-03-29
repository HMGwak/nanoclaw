# Debate Contracts (Preserved)

This document preserves service-neutral debate I/O contract expectations.

## Input Contract (Canonical Fields)

- `topic`: the exact discussion target
- `mode_hint`: optional mode selection (`standard`, `oxford`, `advocate`, `socratic`, `delphi`, `brainstorm`, `tradeoff`)
- `rounds_hint`: optional desired round count
- `participants_hint`: optional participant/role hints
- `background_knowledge_refs`: optional context handles
- `evidence_packs`: typed evidence entries (`web`, `file`, `memory`, `autoresearch_brief`)

## Output Contract (Canonical Fields)

- `round_summaries`: summary for each round
- `final_judgment`: final conclusion produced by the configured adjudication rule
- `rationale`: explicit reasoning behind the conclusion
- `minority_note`: optional dissent summary
- `followups`: optional next actions
