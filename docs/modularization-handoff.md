# Modularization Handoff

## Goal

Keep this fork close to upstream NanoClaw while separating reusable building blocks from service deployment.

The active layering is:

1. `src/`, `container/`
   Generic NanoClaw core and runtime
2. `original_source/`
   Preserved source-of-truth modules and reference assets
3. `src/catalog/*`
   Reusable SDK profiles, agent definitions, toolsets, and service-independent flows
4. `src/services/*`
   Service deployment layers that compose catalog entries
5. `groups/*/AGENTS.md`
   User-local operating policy

## Source of Truth

- Core runtime behavior:
  `src/index.ts`, `src/ipc.ts`, `src/container-runner.ts`, `src/workflows/*`, `src/storage/*`
- Preserved source modules:
  `original_source/*/manifest.json`
- Reusable building blocks:
  `src/catalog/sdk-profiles/*`
  `src/catalog/agents/*`
  `src/catalog/toolsets/*`
  `src/catalog/flows/*`
- Service deployment:
  `src/services/discord/*`
- User-local policy:
  `groups/*/AGENTS.md`

Legacy compatibility fields under `ContainerConfig` such as `leadSender`, `senderBotMap`, `personaMode`, and `subAgents` are no longer the preferred source of truth for Discord deployment semantics.

## What Was Implemented

- Added preserved source scaffolding under `original_source/`
- Added reusable catalog registries under `src/catalog/*`
- Moved Discord deployment semantics to `src/services/discord/*`
- Made workflow start authorization deployment-driven instead of room-name heuristics
- Made workshop speaker names and teammate wiring resolve from service deployment + catalog
- Added manifest loading and validation tests for preserved source references
- Updated docs to describe the new layering

## Current Discord Deployment Model

- `discord_workshop`
  - lead agent: `workshop-teamleader-gpt`
  - teammate agent: `workshop-teammate-kimi`
  - flow: `planning-workshop`
- `discord_planning`
  - lead agent: `planning-lead`
  - allowed to start workflows
- `discord_secretary`
  - lead agent: `secretary-lead`

## Remaining Work

### Host side

- Keep moving service-specific semantics out of generic transport code when possible
- Add more catalog coverage tests if new preserved modules are introduced

### Container side

- Align provider/tool/MCP runtime with the same core/catalog/service layering
- Keep shared skills provider-agnostic
- Avoid new Claude-only assumptions

### Cleanup

- Gradually retire legacy `ContainerConfig` service fields once all callers move to catalog + service deployment specs
- Keep facades (`src/index.ts`, `src/db.ts`, `src/ipc.ts`, `src/container-runner.ts`) upstream-readable

## Guardrails

- Do not derive reusable agents, toolsets, or flows from group config
- Do not put Discord-specific deployment policy into `src/catalog/*`
- Do not put service bindings into `original_source/`
- Do not add new provider-specific architecture when a shared runtime or shared skill path is possible
