# karpathy loop (normalized)

This document captures the reusable, service-neutral loop from the upstream
`program.md`.

Loop:

1. Capture baseline
2. Apply one constrained change
3. Run and collect artifacts
4. Verify against explicit criteria
5. Keep or discard
6. Report and continue

Operational constraints:

- Do one change per iteration.
- Use fixed, explicit run command and timeout.
- Log outcome for every iteration (including crashes).
- Use keep/discard with clear rationale.
- Stop on safety limits (max iterations, failure streak).
