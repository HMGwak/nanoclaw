# NanoClaw

Personal Claude assistant (HMGwak fork).

## References

| Resource | Link |
|----------|------|
| 공식 문서 | https://docs.nanoclaw.dev |
| 공식 문서 인덱스 (LLM용) | https://docs.nanoclaw.dev/llms.txt |
| 로컬 매뉴얼 | [manual.md](manual.md) |
| 내 Fork | https://github.com/HMGwak/nanoclaw |
| Upstream | https://github.com/qwibitai/nanoclaw |
| Discord | https://discord.gg/VDdww8qS42 |

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

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/AGENTS.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
