# NanoClaw Target Architecture Plan

> Purpose: preserve the latest agreed restructuring plan in one file so a new session or a different engineer can continue without relying on chat context.

## 1. Design Goal

Restructure this fork without breaking the core NanoClaw model.

The target is:

- keep NanoClaw core recognizable and upstream-traceable
- keep `group` as the stable runtime execution unit
- separate preserved source, reusable catalog, service-specific hiring/departments, and runtime rooms
- avoid Claude-only architecture
- keep the system provider-agnostic where possible

This plan intentionally prefers:

- stable top-level `groups/`
- service and department metadata in `src/services/*`
- reusable shared assets in `src/catalog/*`
- historical preservation in `original_source/`

## 2. Final Mental Model

### Core

`src/` and `container/` are the national infrastructure.

They own:

- channel abstraction
- DB
- IPC
- container execution
- workflow engine
- provider/tool/MCP runtime

They must not directly encode:

- Discord-specific personas
- service-specific room semantics
- department moods

### Preserved Source

`original_source/` is the national archive / source-of-truth repository.

It stores:

- preserved upstream or external source material
- reference docs
- pipeline descriptions
- provenance metadata

It does not directly execute.

### Catalog

`src/catalog/` is the public education / certification / public infrastructure layer.

It defines reusable, service-neutral assets:

- shared SDK profiles
- service-neutral workers
- global reusable toolsets

It must not define:

- service-owned visible names
- service personas
- department workflows

### Services

`src/services/<service>/` is the operating organization / hiring layer.

A service:

- hires workers from the catalog
- assigns concrete names and personas
- attaches service-local toolsets
- defines departments
- defines department-local workflows
- binds departments to stable runtime groups

### Groups

`groups/` is the runtime room layer.

A group is not the service definition.
A group is not the department policy source.

A group is:

- a stable execution room
- a mount target
- an IPC auth unit
- a workflow assignee target
- a persistent workspace

### Runs

Per-workflow isolation happens under a stable group.

Pattern:

- `groups/<group>/runs/<workflow-id>/`

This keeps NanoClaw’s stable group model intact while still allowing per-workflow isolation of artifacts and handoff files.

## 3. Naming and Identity Rules

### Group IDs

Groups remain flat and top-level.

Pattern:

- `{service}_{department}`

Examples:

- `discord_workshop`
- `discord_planning`
- `discord_secretary`

Why:

- this preserves the existing NanoClaw execution model
- current DB, IPC, mount, and workflow assumptions remain valid
- hierarchical filesystem group IDs would drift further from upstream

### SDK Profiles

SDK profile IDs must be service-neutral.

Examples:

- `openai_gpt54`
- `opencode_kimi_k25`

Not allowed:

- `workshop-teamleader-gpt`
- `planning-lead-gpt`

### Catalog Agent IDs

Catalog agents are `sdk_model_function` workers.

Examples:

- `openai_gpt54_planner`
- `openai_gpt54_generalist`
- `opencode_kimi_k25_researcher`
- `opencode_kimi_k25_implementer`

They are professional functions, not service personas.

Not allowed in catalog:

- `작업실 팀장`
- `키미`
- `기획실`
- `비서실`

### Service Personnel

Concrete personas belong to services.

Examples:

- Discord personnel can be named `작업실 팀장`
- Discord personnel can be named `키미`

Those names do not belong in catalog.

## 4. Toolset Model

Toolsets are split into two layers.

### Global Toolsets

Location:

- `src/catalog/toolsets/*`

Purpose:

- reusable across any service

Examples:

- browser access
- web search
- playwright
- CLI execution

These correspond to public/common tooling.

### Service-Local Toolsets

Location:

- `src/services/<service>/resources/toolsets/*`

Purpose:

- service-specific and domain-specific tools

Examples:

- stock quant tools
- biology repo analysis tools
- service-private MCP bindings
- service-specific local skills

Rule:

- service-local toolsets compose global toolsets
- they do not duplicate the full common allowlist unless necessary

In practice:

- local toolset declares imported global toolset ids
- then adds service-only tools/skills/MCP bindings

## 5. Department Model

Departments belong to services, not to groups.

Location:

- `src/services/<service>/departments/<department>/`

Each department owns:

- `AGENTS.md` for department culture and operating rules
- `workflows/` for department-local workflow definitions or fragments
- `handoff/` for handoff templates
- `group-template/` for stable room defaults if needed

### Department Responsibility

Department policy defines:

- reporting style
- approval rules
- collaboration culture
- handoff style
- what “good work” looks like in that department

Department policy does not define:

- stable runtime group identity
- catalog workers
- shared SDK profiles

## 6. Group Model

Groups are stable runtime rooms and stay top-level.

Location:

- `groups/<group>/`

Each group may contain:

- stable room files
- room-local notes if still needed
- `runs/`

Example:

```text
groups/
  discord_workshop/
    runs/
      wf-001/
      wf-002/
```

### What groups are for

- persistent workspace
- room-specific operational history
- execution target
- artifact storage
- run isolation root

### What groups are not for

- primary source-of-truth for service persona
- primary source-of-truth for department mood
- primary source-of-truth for reusable workers/toolsets

## 7. Workflow Model

### Workflow ownership

Reusable generic workflow engine stays in core.

Concrete step pipelines belong to services and departments.

### Assignee model

Workflow step assignee remains a `group folder`.

Examples:

- `discord_planning`
- `discord_workshop`
- `discord_secretary`

Why:

- current NanoClaw workflow engine already resolves assignees by group folder
- this preserves DB schema and IPC routing assumptions
- this avoids a large upstream-breaking redesign

### Multi-department participation

Supported model:

- sequential department handoff only

Not supported in v1:

- parallel departments on the same step
- simultaneous multi-assignee steps

If multiple departments are needed, express them as sequential steps.

Example:

1. `discord_planning`
2. `discord_workshop`
3. `discord_secretary`

### Step handoff contract

Step-to-step transfer must not carry raw full context.

Allowed transfer:

- output artifact
- handoff note
- acceptance criteria / constraint status

Not allowed as the primary handoff mechanism:

- raw prior conversation context
- implicit shared session state across steps

### Fresh initialization rule

Even if the same worker/personnel appears in multiple steps, each step starts fresh.

That means:

- no session contamination across steps
- re-entry is based on artifacts + handoff note, not previous internal context

## 8. Prompt Assembly Model

The intended final prompt assembly order is:

1. service personnel persona
2. department `AGENTS.md`
3. optional room-local or run-local notes
4. shared skill/tool guidance

This means:

- service owns identity
- department owns culture
- group/run owns workspace-local context

## 9. Archive Model

`archive` belongs under preserved source.

Location:

- `original_source/archive/`

Reason:

- it is the historical record layer
- it should preserve prior source material, retired structures, and migration history

It may contain:

- retired catalog entries
- retired service resources
- retired departments/workflows
- old group templates
- preserved snapshots of old source material
- migration notes

Archive is read-only historical storage, not active runtime configuration.

## 10. Current-to-Target Migration Rules

### Keep

- top-level `groups/`
- flat group ids
- workflow step assignee as group folder
- core workflow engine
- preserved source manifests

### Move out of catalog

- service-specific display names
- service-owned personas
- service-owned workflow definitions

### Move into services

- final personnel
- local toolsets
- department culture
- group ↔ department bindings

### Deprecate gradually

- `groups/*/AGENTS.md` as the main policy source
- legacy service-specific `ContainerConfig` persona fields

They can remain as compatibility overlays during migration, but should not be treated as the final architecture.

## 11. Recommended Folder Targets

### Core

```text
src/
container/
```

### Preserved Source

```text
original_source/
  <module>/
  archive/
```

### Catalog

```text
src/catalog/
  sdk-profiles/
  agents/
  toolsets/
```

### Services

```text
src/services/discord/
  resources/
    personnel/
    toolsets/
    prompts/
  departments/
    workshop/
    planning/
    secretary/
  bindings/
```

### Runtime Rooms

```text
groups/
  discord_workshop/
    runs/
  discord_planning/
    runs/
  discord_secretary/
    runs/
```

## 12. Non-Negotiable Invariants

- Do not replace top-level stable groups with per-run groups.
- Do not move groups under service folders physically.
- Do not make service personas the responsibility of catalog.
- Do not put department mood in the runtime room as the primary source.
- Do not make multi-department workflow parallel in v1.
- Do not let new provider-specific architecture become the primary design path.
- Do not drift away from NanoClaw’s group-based execution model unless a future migration explicitly decides to.

## 13. Current Agreed Direction

This is the current agreed direction from planning:

- preserve NanoClaw’s stable group model
- use `{service}_{department}` group ids
- keep department culture under service departments
- keep final personas under services
- use `group/runs/<workflow-id>/` for per-workflow isolation
- keep multi-department work sequential
- keep archive under `original_source/archive/`

