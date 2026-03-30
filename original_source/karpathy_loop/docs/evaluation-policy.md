# karpathy loop evaluation policy (normalized)

This document captures evaluation and decision policy patterns in a reusable way.

Evaluation:

- Define objective criteria before execution.
- Run independent verification commands after execution.
- Treat crash/no-result as a failed iteration.

Decision policy:

- Keep when criteria pass and objective trend improves.
- Discard when criteria fail or objective regresses.
- On ties, prefer simpler and lower-risk changes.

Artifacts:

- Baseline summary
- Per-iteration run result
- Per-iteration verification result
- Final keep/discard rationale
