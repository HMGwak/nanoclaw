# entireio-cli session memory and checkpoint model (normalized)

This document preserves upstream concepts from `entireio/cli` for NanoClaw
catalog localization.

## Preserved concepts

1. Session as top-level work unit.
2. Checkpoint as point-in-time snapshot bound to session context.
3. Metadata-first logging:
- `session_id` as root trace.
- `tool_use_id` (or equivalent span id) for sub-task correlation.
- status, timestamps, and artifact references instead of raw sensitive content.
4. Structured append-only event trails (`jsonl`) for replay and audit.
5. Condensed memory for next-step execution:
- keep detailed event trail persisted.
- inject compact summary into subsequent execution prompt.

## Practical localization guidance

- Use file-first memory under run scope:
  - `groups/<group>/runs/<workflow-id>/memory/*.jsonl`
- Write one event per stage result (`completed` or `failed`).
- Keep prompt injection bounded (recent N records and concise summaries).
- Keep PII-sensitive raw payloads out of memory artifacts by default.

## Explicit non-goals

- Reproducing upstream git-branch checkpoint architecture.
- Reproducing upstream hook protocol details.
- Enforcing provider-specific runtime behavior in preserved layer.
