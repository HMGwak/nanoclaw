# NanoClaw

Personal containerized AI assistant fork (HMGwak fork).

## References

| Resource                 | Link                                 |
| ------------------------ | ------------------------------------ |
| 공식 문서                | https://docs.nanoclaw.dev            |
| 공식 문서 인덱스 (LLM용) | https://docs.nanoclaw.dev/llms.txt   |
| 로컬 매뉴얼              | [manual.md](manual.md)               |
| 내 Fork                  | https://github.com/HMGwak/nanoclaw   |
| Upstream                 | https://github.com/qwibitai/nanoclaw |
| Discord                  | https://discord.gg/VDdww8qS42        |

### 공식 문서 주요 페이지

- [소개](https://docs.nanoclaw.dev/introduction) | [설치](https://docs.nanoclaw.dev/installation) | [빠른 시작](https://docs.nanoclaw.dev/quickstart)
- [아키텍처](https://docs.nanoclaw.dev/concepts/architecture) | [보안](https://docs.nanoclaw.dev/concepts/security) | [컨테이너](https://docs.nanoclaw.dev/concepts/containers) | [그룹](https://docs.nanoclaw.dev/concepts/groups) | [태스크](https://docs.nanoclaw.dev/concepts/tasks)
- [메시징](https://docs.nanoclaw.dev/features/messaging) | [커스터마이징](https://docs.nanoclaw.dev/features/customization) | [Agent Swarms](https://docs.nanoclaw.dev/features/agent-swarms) | [웹 액세스](https://docs.nanoclaw.dev/features/web-access) | [CLI](https://docs.nanoclaw.dev/features/cli) | [스케줄 태스크](https://docs.nanoclaw.dev/features/scheduled-tasks)
- [스킬 시스템](https://docs.nanoclaw.dev/integrations/skills-system) | [스킬 만들기](https://docs.nanoclaw.dev/api/skills/creating-skills)
- [WhatsApp](https://docs.nanoclaw.dev/integrations/whatsapp) | [Telegram](https://docs.nanoclaw.dev/integrations/telegram) | [Discord](https://docs.nanoclaw.dev/integrations/discord) | [Slack](https://docs.nanoclaw.dev/integrations/slack) | [Gmail](https://docs.nanoclaw.dev/integrations/gmail)
- [설정](https://docs.nanoclaw.dev/api/configuration) | [메시지 라우팅 API](https://docs.nanoclaw.dev/api/message-routing) | [그룹 관리 API](https://docs.nanoclaw.dev/api/group-management) | [태스크 API](https://docs.nanoclaw.dev/api/task-scheduling)
- [컨테이너 런타임](https://docs.nanoclaw.dev/advanced/container-runtime) | [IPC](https://docs.nanoclaw.dev/advanced/ipc-system) | [Remote Control](https://docs.nanoclaw.dev/advanced/remote-control) | [보안 심화](https://docs.nanoclaw.dev/advanced/security-model) | [Docker Sandboxes](https://docs.nanoclaw.dev/advanced/docker-sandboxes) | [트러블슈팅](https://docs.nanoclaw.dev/advanced/troubleshooting)

## Git Remotes

- `origin` → `HMGwak/nanoclaw` (내 fork, push 대상)
- `upstream` → `qwibitai/nanoclaw` (원본, pull 대상)

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to isolated container agents. Each group has isolated filesystem and memory.

## Design Rules

- Provider-agnostic first. New architecture must work across `openai`, `opencode`, `zai`, `openai-compat`, and `claude` unless there is a very strong reason not to.
- Stay close to upstream NanoClaw. Prefer changes that remain understandable as user-level customization of the original repo rather than a divergent rewrite.
- Shared behavior belongs in common runtime paths, common prompt assembly, or common container skills. Do not hide core behavior in one provider's private mechanism.
- Claude-only design is forbidden for new work. Existing `.claude/*` paths and Claude-specific flows are legacy compatibility layers, not templates for future architecture.
- Follow NanoClaw philosophy from `README.md`: keep the core small, understandable, and easy to customize in code. Do not add framework-like abstraction unless it clearly simplifies the system.
- Separate core from fork-specific extensions. Multi-backend support may stay core for this fork, but Discord multi-bot behavior, workshop/planning workflow, and persona-specific room logic should live behind explicit extension boundaries.
- Structure the fork in four layers: preserved source modules (`original_source/`), reusable SDK/agent/toolset/flow catalogs (`src/catalog/*`), service deployment (`src/services/*`), and user-local operating policy (`groups/*/AGENTS.md`).
- Preserved source modules are not vendor dependencies. They are read-mostly source-of-truth assets used to derive agents, toolsets, and flows without losing the original reference material.
- Service folders such as Discord or Symphony should compose existing catalog entries. They should not redefine agents, toolsets, flows, or SDK base profiles unless the change is genuinely generic and belongs back in the reusable catalog layer.
- No patchwork architecture. Do not stack temporary routing layers, duplicate abstractions, or ad hoc compatibility shims when a direct design is possible.
- Minimize fallbacks. Prefer one clear source of truth and one primary execution path. Add fallback behavior only when it is necessary for correctness or backwards compatibility.
- Do not mask runtime failures with fallback responses that look like success. Never claim workflow/task execution succeeded unless backend registration and routing actually succeeded.
- Fail fast on invalid execution requests. Missing required fields, invalid assignees, unauthorized starts, and missing chat identifiers must return explicit user-visible errors instead of silent drops.
- Skills are first-class. If behavior is meant to be shared across providers, prefer the existing NanoClaw skill system and container skill source tree over inventing a parallel capability framework.
- Keep provider-specific code narrow. Backend adapters may differ in transport or SDK usage, but they should consume the same high-level instructions, memory, and shared operational guidance whenever feasible.
- Before changing architecture, verify it against actual repo docs and code paths, especially `README.md`, `CONTRIBUTING.md`, `src/container-runner.ts`, and `container/skills/`.

## Structure

```text
nanoclaw/
├── src/                         # Core NanoClaw runtime
│   ├── channels/                # Generic channel transports/adapters
│   ├── storage/                 # Generic repositories
│   ├── workflows/               # Generic workflow engine
│   ├── catalog/                 # Reusable SDK profiles, agents, toolsets, flows
│   └── services/                # Service deployment layers (Discord, etc.)
├── container/                   # Core container runtime
│   ├── agent-runner/            # Provider/tool/MCP runtime
│   └── skills/                  # Shared container skill source
├── original_source/             # Preserved original modules, docs, pipelines
└── groups/                      # User-local operating policy and room memory
```

Layer responsibilities:

- `src/` and `container/` are core. Keep them generic and upstream-traceable.
- `original_source/` preserves source-of-truth assets used to derive reusable building blocks.
- `src/catalog/` defines reusable SDK profiles, agents, toolsets, and service-independent flows.
- `src/services/` composes catalog entries for a concrete service such as Discord.
- `groups/*/AGENTS.md` defines local room policy, tone, and operating rules.

Allowed dependency direction:

- core may not depend on service-specific room semantics
- catalog may depend on preserved source metadata, but not on service deployment
- services may compose catalog entries, but should not redefine them
- groups may customize operating policy, but are not the source-of-truth for agents/toolsets/flows

## Key Files

| File                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `src/index.ts`             | Orchestrator: state, message loop, agent invocation                 |
| `src/channels/registry.ts` | Channel registry (self-registration at startup)                     |
| `src/ipc.ts`               | IPC watcher and task processing                                     |
| `src/router.ts`            | Message formatting and outbound routing                             |
| `src/config.ts`            | Trigger pattern, paths, intervals                                   |
| `src/container-runner.ts`  | Spawns agent containers with mounts                                 |
| `src/task-scheduler.ts`    | Runs scheduled tasks                                                |
| `src/db.ts`                | SQLite operations                                                   |
| `groups/{name}/AGENTS.md`  | Per-group memory (isolated)                                         |
| `container/skills/`        | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration    |
| `/customize`        | Adding channels, integrations, changing behavior                  |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install         |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Runtime policy:

- Run NanoClaw in Docker only.
- Do not use `launchd`, `systemd`, `tmux`, `nohup`, or ad-hoc host `npm start`.
- Host execution is blocked by default in `src/index.ts` unless explicitly overridden with `NANOCLAW_ALLOW_HOST_RUNTIME=1`.
- Use `./scripts/docker-up.sh` to start, `./scripts/docker-down.sh` to stop, `./scripts/docker-logs.sh` for logs.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
