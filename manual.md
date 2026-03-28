# NanoClaw Manual

> 공식 문서 사이트: https://docs.nanoclaw.dev
> GitHub: https://github.com/qwibitai/nanoclaw
> 내 Fork: https://github.com/HMGwak/nanoclaw
> Discord: https://discord.gg/VDdww8qS42

---

## 목차

1. [개요](#개요)
2. [설치](#설치)
3. [빠른 시작](#빠른-시작)
4. [아키텍처](#아키텍처)
5. [보안](#보안)
6. [컨테이너 격리](#컨테이너-격리)
7. [그룹 격리](#그룹-격리)
8. [태스크 스케줄링](#태스크-스케줄링)
9. [메시지 처리와 라우팅](#메시지-처리와-라우팅)
10. [커스터마이징](#커스터마이징)
11. [Agent Swarms](#agent-swarms)
12. [웹 액세스와 브라우저 자동화](#웹-액세스와-브라우저-자동화)
13. [CLI (claw)](#cli-claw)
14. [스킬 시스템](#스킬-시스템)
15. [스킬 만들기](#스킬-만들기)
16. [채널 연동](#채널-연동)
17. [IPC 시스템](#ipc-시스템)
18. [Remote Control](#remote-control)
19. [컨테이너 런타임](#컨테이너-런타임)
20. [Docker Sandboxes](#docker-sandboxes)
21. [설정 (Configuration)](#설정-configuration)
22. [API 아키텍처](#api-아키텍처)
23. [메시지 라우팅 API](#메시지-라우팅-api)
24. [그룹 관리 API](#그룹-관리-api)
25. [태스크 스케줄링 API](#태스크-스케줄링-api)
26. [보안 심화](#보안-심화)
27. [트러블슈팅](#트러블슈팅)

---

## 개요

> 원문: https://docs.nanoclaw.dev/introduction

NanoClaw은 격리된 컨테이너에서 에이전트를 실행하고 메시징 플랫폼에 연결하는 경량 AI 어시스턴트.

- Single Node.js 프로세스, SQLite 메시지 큐, Apple Container 또는 Docker로 격리
- 컨테이너 격리: 에이전트는 명시적으로 마운트된 것만 접근 가능 (permission 기반이 아닌 OS 수준 격리)
- 멀티 플랫폼: WhatsApp, Telegram, Discord, Slack, Gmail
- Agent Swarms: 협업 에이전트 팀 지원
- 스케줄 태스크: 자연어로 반복 작업 설정
- 코드 기반 커스터마이징: 설정 파일 대신 코드 직접 수정
- ~39.8k 토큰의 소스 코드, MIT 라이선스

---

## 설치

> 원문: https://docs.nanoclaw.dev/installation

### 시스템 요구사항

| 플랫폼 | 요구사항 |
|--------|---------|
| macOS | Big Sur+, Intel/Apple Silicon, 4GB RAM, 2GB 디스크 |
| Linux | Ubuntu 20.04+, x86_64, 2GB RAM, systemd |
| Windows | WSL 2 + Ubuntu 20.04+, 4GB RAM |

### 필수 구성요소

1. **Node.js 22**: Homebrew(macOS), NodeSource(Linux), nvm
2. **백엔드 자격증명**: OpenAI, OpenCode, Z.AI, OpenAI-compatible, 또는 Claude 중 하나
3. **컨테이너 런타임**: Apple Container(macOS) 또는 Docker
4. **빌드 도구**: Xcode CLI Tools(macOS) 또는 build-essential(Linux)
5. **OneCLI v1.2.22+**: Claude 백엔드를 쓸 때만 필요
6. **Claude Code**: `/setup`, `/debug` 같은 스킬 워크플로를 쓸 때 선택

### 설치 단계

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
npm install

# 예시: OpenAI를 기본 백엔드로 사용
cat >> .env <<'EOF'
OPENAI_API_KEY=sk-...
EOF
```

필요하면 `AGENT_BACKEND=openai|opencode|zai|openai-compat|claude`를 명시한다.
Claude Code 기반 온보딩을 선호하면 `claude`를 실행한 뒤 `/setup`을 써도 된다.

### 서비스 관리

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

컨테이너 이미지: Node.js 24, Chromium, agent-runner 포함.

---

## 빠른 시작

> 원문: https://docs.nanoclaw.dev/quickstart

Claude Code를 쓰는 경우 `/setup` 명령이 모든 것을 처리한다. 수동 구성 시에는 `.env`에 백엔드 키를 넣고 서비스만 따로 구성하면 된다.

1. 의존성 확인 (Node.js 20+)
2. 컨테이너 런타임 설정 (Docker 또는 Apple Container)
3. 백엔드 인증 설정 (`OPENAI_API_KEY`, `OPENCODE_API_KEY`, `ZAI_API_KEY`, `OPENAI_COMPAT_*`, `ANTHROPIC_*` 중 하나)
4. 채널 선택 (WhatsApp, Telegram, Discord, Slack, Gmail)
5. 서비스 설치 (launchd, systemd, WSL wrapper)

트리거 워드(기본 `@Andy`)와 메인 채널(관리자 권한) 설정 필요.

업데이트: `/update-nanoclaw` 명령으로 로컬 커스터마이징 보존하면서 버전 업데이트.

---

## 아키텍처

> 원문: https://docs.nanoclaw.dev/concepts/architecture

```
Channels --> SQLite --> Polling loop --> Container (Agent Runner) --> Response
```

### 핵심 컴포넌트

- **Channel Factory**: 팩토리 레지스트리 패턴. 메시징 채널이 시작 시 자동 등록. 자격증명 없으면 경고만.
- **Message Router**: SQLite를 2초마다 폴링. 트리거 패턴 확인, 커서 상태 유지.
- **Group Queue**: 설정 가능한 동시성(기본 5), 그룹별 상태, 지수 백오프 재시도, 30분 유휴 타임아웃.
- **Container Runner**: 격리된 에이전트 실행. 볼륨 마운트 구성, Docker CLI, stdin JSON, stdout 스트리밍, 출력 마커 파싱.
- **Task Scheduler**: 60초 폴링 간격. cron, 밀리초 인터벌, 일회성 ISO 타임스탬프 지원.
- **IPC Watcher**: 컨테이너-호스트 통신. 파일 기반. 원자적 쓰기로 레이스 컨디션 방지.

### DB 및 저장소

SQLite: 메시지, 채팅 메타데이터, 세션 ID, 등록 그룹, 라우터 상태, 예약 태스크, 태스크 실행 로그.

### 컨테이너 이미지

- Node.js 24-slim 기반
- Chromium (브라우저 자동화)
- 비루트 사용자 실행
- `/workspace/group`이 작업 디렉토리

### 시작/종료

초기화: 컨테이너 확인 → DB 설정 → 상태 복원 → 채널 연결 → 서브시스템 시작.
종료: 활성 컨테이너는 데이터 손실 방지를 위해 의도적으로 detach (강제 종료 아님).

---

## 보안

> 원문: https://docs.nanoclaw.dev/concepts/security

### 트러스트 모델

| 엔티티 | 신뢰 수준 | 이유 |
|--------|----------|------|
| 메인 그룹 | Trusted | 개인 셀프챗, 관리자 |
| 비메인 그룹 | Untrusted | 다른 사용자가 악의적일 수 있음 |
| 컨테이너 에이전트 | Sandboxed | 격리된 실행 환경 |
| 수신 메시지 | User input | 프롬프트 인젝션 가능성 |

### 보안 경계

1. **컨테이너 격리** (주 경계): 프로세스/파일시스템 격리, 비루트 실행, 임시 컨테이너(`--rm`)
2. **마운트 보안**: 외부 허용목록(`~/.config/nanoclaw/mount-allowlist.json`), 심볼릭 링크 해석, 차단 패턴(`.ssh`, `.aws` 등)
3. **세션 격리**: 그룹별 독립 에이전트 세션
4. **IPC 인가**: 그룹 신원 검증, 비메인 그룹은 자기 채팅만 가능
5. **발신자 허용목록**: `~/.config/nanoclaw/sender-allowlist.json`, trigger/drop 모드
6. **자격증명 처리**: Claude는 OneCLI 게이트웨이, 나머지 백엔드는 환경변수 주입 방식 사용

### 권한 비교

| 기능 | 메인 그룹 | 비메인 그룹 |
|------|----------|------------|
| 프로젝트 루트 | `/workspace/project` (ro) | 없음 |
| 그룹 폴더 | `/workspace/group` (rw) | `/workspace/group` (rw) |
| 글로벌 메모리 | 프로젝트 마운트 통해 | `/workspace/global` (ro) |
| 추가 마운트 | 설정 가능 | 읽기 전용 |
| 네트워크 | 무제한 | 무제한 |

### 공격 시나리오 대응

- **프롬프트 인젝션**: 자기 그룹 컨텍스트만 접근, 다른 그룹 메시지 전송 불가
- **컨테이너 탈출**: 커널 수준 격리, 비루트, 임시 컨테이너
- **심볼릭 링크 우회**: 실제 경로로 해석 후 검증
- **IPC 권한 상승**: 그룹 신원 검증, 무시 및 로그

---

## 컨테이너 격리

> 원문: https://docs.nanoclaw.dev/concepts/containers

- 프로세스 격리, 파일시스템 격리, 리소스 제약(계획), 임시 환경, 비권한 실행
- Docker(기본) 또는 Apple Container(macOS)
- 베이스 이미지: `node:24-slim` + Chromium + agent-runner
- `.env` 파일은 `/dev/null`로 섀도잉하여 에이전트가 시크릿 읽지 못하게 함
- 메인 그룹: 프로젝트 디렉토리 ro + 그룹 폴더 rw
- 비메인 그룹: `/workspace/project` 접근 불가
- 출력 파싱: sentinel 마커 (`---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---`)
- 타임아웃: 유휴 30분, 하드 30분 30초

---

## 그룹 격리

> 원문: https://docs.nanoclaw.dev/concepts/groups

- 각 그룹 = 격리된 컨텍스트 (그룹 채팅 또는 개별 대화에 대응)
- **메인 그룹**: 관리자, 전체 권한, 다른 그룹 관리 가능
- **비메인 그룹**: 격리, 다른 그룹 데이터 접근 불가

격리 메커니즘:
1. **파일시스템 격리**: 그룹별 전용 폴더
2. **세션 격리**: 그룹별 독립 대화 히스토리
3. **IPC 네임스페이스 격리**: 그룹 간 메시지 전송/태스크 예약 차단
4. **메시지 커서 격리**: 크래시 복구 시 교차 오염 방지

글로벌 메모리: `groups/global/` 공유 디렉토리, 메인 그룹만 쓰기 가능.

---

## 태스크 스케줄링

> 원문: https://docs.nanoclaw.dev/concepts/tasks
> 원문: https://docs.nanoclaw.dev/features/scheduled-tasks

### 스케줄 유형

| 유형 | 예시 | 설명 |
|------|------|------|
| Cron | `0 9 * * 1-5` | 평일 오전 9시 |
| Interval | `3600000` | 매 1시간 |
| Once | `2026-03-01T10:00:00Z` | 일회성 |

### 실행 흐름

1. 스케줄러가 60초마다 DB 폴링
2. 만기 태스크 발견 시 GroupQueue에 인큐
3. 컨테이너 스팬, 에이전트가 태스크 프롬프트 실행
4. 결과를 그룹 챗에 자동 전달
5. `next_run` 재계산

### 컨텍스트 모드

- **isolated** (기본): 실행마다 새 세션, 히스토리 없음
- **group**: 그룹의 기존 세션 사용, 이전 대화 기억

### 자연어 태스크 생성

```
@Andy send me a summary of my calendar every weekday at 9am
@Andy check for new GitHub issues every hour and notify me
@Andy remind me to review the budget tomorrow at 2pm
```

### 태스크 관리

```
@Andy list all scheduled tasks
@Andy pause the Monday briefing task
@Andy resume the calendar summary task
@Andy cancel the reminder about the meeting
```

### 타임존

```bash
export TZ="Asia/Seoul"  # .env에 설정
```

기본값: 시스템 타임존.

---

## 메시지 처리와 라우팅

> 원문: https://docs.nanoclaw.dev/features/messaging

### 파이프라인

1. **저장**: SQLite에 발신자, 타임스탬프, 채팅 메타데이터 기록
2. **감지**: 트리거 패턴 확인 (기본 `@Andy`)
3. **컨텍스트 조합**: 마지막 에이전트 응답 이후 모든 메시지 수집
4. **호출**: 컨테이너화된 현재 백엔드 에이전트에 전송
5. **응답**: 내부 태그 제거 후 채널로 라우팅

### 메시지 포맷

```xml
<context timezone="Asia/Seoul" />
<messages>
<message sender="Alice" time="2026-03-26 10:30 AM">@Andy 오늘 날씨 어때?</message>
</messages>
```

### 내부 태그

에이전트가 `<internal>...</internal>` 태그에 추론을 넣으면 사용자에게 전송되지 않음.

### 큐 관리

- 그룹별 메시지 큐, 글로벌 동시성 제한 (기본 5)
- 유휴 컨테이너 30분 유지
- 에이전트 호출당 최근 200개 메시지

### 설정값

- 폴링 간격: 2초
- 유휴 타임아웃: 30분
- 메시지 캡: 200

---

## 커스터마이징

> 원문: https://docs.nanoclaw.dev/features/customization

설정 파일 없음. 코드 직접 수정 방식.

```
"Change the trigger word to @Bob"          → src/config.ts, .env 수정
"Make responses shorter and more direct"   → groups/main/AGENTS.md 수정
```

설정 우선순위: 런타임 환경변수 > `.env` > 하드코딩 기본값

기능 확장은 스킬로.

---

## Agent Swarms

> 원문: https://docs.nanoclaw.dev/features/agent-swarms

"teams of specialized agents that collaborate on complex tasks"

- 메인 오케스트레이터가 전문 서브에이전트 스팬
- 서브에이전트: `containerConfig.subAgents`로 등록, `ask_agent` 도구로 호출, 독립 백엔드 세션으로 실행

### 조정 패턴

- Sequential: 순차 실행
- Parallel: 병렬 실행
- Hierarchical: 코디네이터가 서브팀 스팬

### 유의사항

- 실험적 기능, API 호출 비용/시스템 오버헤드 있음
- 단순 쿼리에는 비권장

---

## 웹 액세스와 브라우저 자동화

> 원문: https://docs.nanoclaw.dev/features/web-access

`agent-browser` 도구:

- 웹 검색, 페이지 읽기, 폼 자동화, 데이터 스크래핑, 스크린샷
- 인증 세션 저장/재사용
- 모든 에이전트에 자동 사용 가능, 설정 불필요
- 헤드리스 Chromium, 그룹별 격리 브라우저 세션
- 브라우저 인스턴스당 100-200MB RAM

---

## CLI (claw)

> 원문: https://docs.nanoclaw.dev/features/cli

터미널에서 직접 NanoClaw 에이전트 호출:

```bash
claw "오늘 일정 알려줘"
claw --group work "PR 리뷰해줘"
claw --session abc123 "이어서 해줘"
echo "코드 리뷰해줘" | claw
```

요구사항: Python 3.8+, 빌드된 컨테이너 이미지, Docker 또는 Apple Container

설치: `/claw` 스킬 → `scripts/claw` + `~/bin/claw` symlink

---

## 스킬 시스템

> 원문: https://docs.nanoclaw.dev/integrations/skills-system

git 기반 스킬 아키텍처. 브랜치 머지로 기능 추가.

### 리포지토리 구조

- **main**: 채널/스킬 코드 없는 코어
- **skill branches**: 개별 기능 구현 (ollama-tool, compact, apple-container 등)
- **Channel forks**: 별도 리포 (nanoclaw-whatsapp, nanoclaw-telegram 등)

### 4가지 스킬 유형

| 유형 | 설명 | 위치 |
|------|------|------|
| Feature | 브랜치 머지로 설치 | `skill/*` 브랜치 |
| Utility | 코드 파일 포함, 자체 디렉토리 | `.claude/skills/<name>/` |
| Operational | 명령어 전용, 코드 변경 없음 | `.claude/skills/` on main |
| Container | 컨테이너 런타임에 로드 | `container/skills/` |

### 스킬 적용

```bash
# Claude Code 스킬 사용 시
/add-telegram

# 수동 (채널 포크)
git remote add discord https://github.com/qwibitai/nanoclaw-discord.git
git fetch discord main
git merge discord/main

# 수동 (업스트림 스킬)
git fetch upstream skill/ollama-tool
git merge upstream/skill/ollama-tool
```

### 스킬 제거

```bash
git log --merges --oneline | grep discord
git revert -m 1 <merge-commit>
```

### 스킬 업데이트

```bash
git fetch upstream main
git merge upstream/main
# 또는
/update-skills
```

### 사용 가능한 채널 스킬

`/add-whatsapp`, `/add-telegram`, `/add-discord`, `/add-slack`, `/add-gmail`

### 업스트림 스킬

`/add-compact`, `/add-ollama-tool`, `/add-parallel`, `/convert-to-apple-container`, `/use-native-credential-proxy`

---

## 스킬 만들기

> 원문: https://docs.nanoclaw.dev/api/skills/creating-skills

### SKILL.md 포맷

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---

Instructions here...
```

규칙:
- 500줄 미만, 상세 내용은 별도 파일
- `name`: 소문자, 영숫자+하이픈, 64자 이내
- `description`: 필수

### 개발 프로세스

1. 스킬 유형 선택
2. Feature: `skill/*` 브랜치 생성, 코드 변경
3. Utility: 자체 디렉토리 구조
4. Operational: 명확한 단계별 명령어
5. Container: 집중된 SKILL.md
6. 테스트 후 PR

### 모범 사례

- `AskUserQuestion`으로 사용자 입력 받기
- Pre-flight → Implementation → Verification 단계
- 플랫폼 차이 처리 (macOS, Linux, WSL)
- 검증 단계 포함

---

## 채널 연동

### WhatsApp

> 원문: https://docs.nanoclaw.dev/integrations/whatsapp

- Baileys 라이브러리, WhatsApp Web API
- `/add-whatsapp` 스킬로 설치
- QR 코드 인증, `store/auth/`에 자격증명 저장
- 공유 번호 모드 vs 전용 번호 모드 (`ASSISTANT_HAS_OWN_NUMBER`)
- 추가 스킬: 음성 전사, 이미지 비전, PDF 읽기, 이모지 반응

### Telegram

> 원문: https://docs.nanoclaw.dev/integrations/telegram

- grammy 라이브러리, Bot API
- `/add-telegram` 스킬로 설치
- @BotFather에서 봇 토큰 생성
- `TELEGRAM_BOT_TOKEN` 환경변수 설정
- JID 형식: 개인 `tg:123456789`, 그룹 `tg:-1001234567890`
- Agent Swarm: `/add-telegram-swarm`으로 멀티 봇 지원

### Discord

> 원문: https://docs.nanoclaw.dev/integrations/discord

- `/add-discord` 스킬로 설치

### Slack

> 원문: https://docs.nanoclaw.dev/integrations/slack

- Socket Mode (공개 URL 불필요)
- `/add-slack` 스킬로 설치

### Gmail

> 원문: https://docs.nanoclaw.dev/integrations/gmail

- 도구 모드 또는 풀 채널 모드
- GCP OAuth 설정 필요
- `/add-gmail` 스킬로 설치

---

## IPC 시스템

> 원문: https://docs.nanoclaw.dev/advanced/ipc-system

파일시스템 기반 프로세스 간 통신:

- 그룹별 네임스페이스: `data/ipc/{group}/`
- 하위 디렉토리: `messages/`, `tasks/`, `input/`
- JSON 파일 작성 → 호스트 폴링(1000ms) → 인가 검증 → 실행 → 파일 삭제
- 실패 시 `data/ipc/errors/`로 이동
- 디렉토리 경로로 소스 그룹 신원 확인 (스푸핑 불가)

### 지원 작업

- **Send Message**: 메인은 모든 채팅, 비메인은 자기 채팅만
- **Task Management**: schedule, pause, resume, update, cancel
- **Refresh Groups**: 메인만
- **Register Group**: 메인만

---

## Remote Control

> 원문: https://docs.nanoclaw.dev/advanced/remote-control

브라우저에서 Claude Code 세션 열기:

```
/remote-control      → URL 반환: https://claude.ai/code?bridge=env_abc123
/remote-control-end  → 세션 종료
```

- 메인 그룹 전용 (호스트 수준 접근 권한)
- `claude remote-control` 자식 프로세스 스팬
- 세션 메타데이터: `{DATA_DIR}/remote-control.json`
- 호스트 재시작 시 자동 복구

---

## 컨테이너 런타임

> 원문: https://docs.nanoclaw.dev/advanced/container-runtime

### 런타임 옵션

| 기능 | Docker | Apple Container |
|------|--------|-----------------|
| 바인드 마운트 | `-v host:container:ro` | `--mount type=bind,...` |
| 중지 | `docker stop -t 1 name` | `container stop name` |
| 헬스 체크 | `docker info` | `container system status` |

전환: `/convert-to-apple-container` 스킬

### 컨테이너 수명주기

1. 그룹 권한에 따라 볼륨 마운트 구성
2. 타임스탬프 기반 고유 컨테이너 이름 생성
3. stdin/stdout/stderr 파이프로 컨테이너 스팬
4. stdin으로 JSON 입력 전달
5. sentinel 마커로 출력 스트리밍
6. 완료 후 그룹 로그 디렉토리에 로그 기록

### 타임아웃

- 유휴 타임아웃: 30분 비활성 후 graceful shutdown
- 하드 타임아웃: 30분 30초 후 force kill
- 활동이 있으면 타임아웃 리셋

---

## Docker Sandboxes

> 원문: https://docs.nanoclaw.dev/advanced/docker-sandboxes

이중 격리: 샌드박스 VM 경계 + 내부 Docker 컨테이너

요구사항: Docker Desktop 4.40+, 샌드박스 기능 활성화

적용 시점:
- 멀티 테넌트 환경
- 신뢰할 수 없는 커뮤니티 스킬 실행
- CI/CD 자동화

---

## 설정 (Configuration)

> 원문: https://docs.nanoclaw.dev/api/configuration

### 주요 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `ASSISTANT_NAME` | "Andy" | 트리거 패턴의 어시스턴트 이름 |
| `ASSISTANT_HAS_OWN_NUMBER` | false | 전용 계정 여부 |
| `CONTAINER_IMAGE` | "nanoclaw-agent:latest" | Docker 이미지 |
| `CONTAINER_TIMEOUT` | 30분 | 최대 실행 시간 |
| `CONTAINER_MAX_OUTPUT_SIZE` | 10MB | 출력 크기 제한 |
| `IDLE_TIMEOUT` | 30분 | 유휴 컨테이너 유지 시간 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | 동시 컨테이너 제한 |
| `TZ` | 시스템 | 타임존 |
| `OLLAMA_HOST` | - | Ollama API 엔드포인트 |

### 디렉토리 구조

- `store/` — DB, 영구 저장소
- `groups/` — 그룹 폴더, 메모리
- `data/` — 런타임 세션, IPC 네임스페이스
- `~/.config/nanoclaw/` — 보안 허용목록 (프로젝트 외부)

---

## API 아키텍처

> 원문: https://docs.nanoclaw.dev/api/overview

5개 핵심 모듈:

1. **Orchestrator**: 상태 관리, 에이전트 호출
2. **Message Router**: 포맷, 채널 전달
3. **Container Runner**: 격리 에이전트 환경 스팬
4. **Task Scheduler**: 반복 자동화
5. **Database**: SQLite 영속화

SQLite 테이블: `chats`, `messages`, `registered_groups`, `sessions`, `scheduled_tasks`

---

## 메시지 라우팅 API

> 원문: https://docs.nanoclaw.dev/api/message-routing

핵심 함수:

- `escapeXml`: XML 특수문자 이스케이프
- `formatMessages`: 메시지 배열 → XML 포맷 (타임존 헤더 포함)
- `stripInternalTags`: `<internal>...</internal>` 블록 제거
- `formatOutbound`: 에이전트 출력 정리
- `routeOutbound`: 채팅 JID에 따라 적절한 채널로 라우팅
- `findChannel`: JID 소유 채널 검색

---

## 그룹 관리 API

> 원문: https://docs.nanoclaw.dev/api/group-management

핵심 함수:

- `registerGroup()`: 새 그룹 등록 (폴더 경로 검증, 디렉토리 생성, 설정 저장)
- `getAvailableGroups()`: 최근 활동 순 그룹 목록
- `loadState()` / `saveState()`: 라우터 상태 영속화
- `recoverPendingMessages()`: 크래시 복구

`RegisteredGroup` 인터페이스: 이름, 폴더, 트리거 패턴, 컨테이너 설정 등.
폴더 이름: 영숫자, 하이픈, 언더스코어만 허용 (경로 순회 공격 방지).

---

## 태스크 스케줄링 API

> 원문: https://docs.nanoclaw.dev/api/task-scheduling

핵심 함수:

- `startSchedulerLoop()`: 스케줄러 시작, 60초마다 폴링
- `createTask()`: 새 태스크 생성
- `getTaskById()` / `getTasksForGroup()`: 태스크 조회
- `updateTask()`: 태스크 수정
- `deleteTask()`: 태스크 및 관련 로그 삭제
- `getDueTasks()`: `next_run <= NOW()`인 활성 태스크

---

## 보안 심화

> 원문: https://docs.nanoclaw.dev/advanced/security-model

커널 수준 격리. 에이전트는 명시적으로 마운트된 파일시스템만 접근.

### 마운트 보안

허용목록: `~/.config/nanoclaw/mount-allowlist.json`

```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true, "description": "개발 프로젝트" }
  ],
  "blockedPatterns": ["password", "secret", "token"],
  "nonMainReadOnly": true
}
```

차단 기본 패턴: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.gcloud`, `.kube`, `.docker`, `credentials`, `.env`, `.netrc`, `id_rsa`, `id_ed25519`, `private_key`, `.secret`

### 발신자 허용목록

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "120363001234567890@g.us": {
      "allow": ["5511999887766@s.whatsapp.net"],
      "mode": "trigger"
    }
  },
  "logDenied": true
}
```

| 모드 | 동작 |
|------|------|
| trigger | 메시지 저장하지만 에이전트 활성화 안 함 |
| drop | DB 전에 조용히 폐기 |

### 자격증명

- **OpenAI / OpenCode / Z.AI / OpenAI-compatible**: 호스트가 `.env`에서 읽은 키를 컨테이너에 직접 주입
- **OneCLI Gateway**: Claude 백엔드에서 호스트 프로세스가 API 키를 직접 다루지 않도록 게이트웨이가 시크릿 주입
- **Legacy Credential Proxy**: 호스트 HTTP 프록시(기본 3001). 컨테이너는 placeholder 토큰 받고, 프록시가 실제 자격증명으로 교체

---

## 트러블슈팅

> 원문: https://docs.nanoclaw.dev/advanced/troubleshooting

### 진단 명령

```bash
# 서비스 상태
launchctl list | grep nanoclaw     # macOS
systemctl --user status nanoclaw   # Linux

# 컨테이너 상태
docker ps --filter name=nanoclaw

# 최근 로그 확인
ls -lt groups/*/logs/ | head -20
```

### 주요 문제

- **에이전트 응답 없음**: 트리거 워드 확인, Docker 실행 중인지, 동시성 제한 초과 여부
- **컨테이너 타임아웃**: exit code 137, 타임아웃 값 증가, 무한 루프 확인
- **WhatsApp 인증**: `/add-whatsapp` 재실행, 서비스 재시작
- **마운트 오류**: 허용목록 설정, 심볼릭 링크 해석, 권한 확인
- **IPC 문제**: 비메인 그룹 메시지 접근 제한, JSON 유효성 검사

### 지원

- 유지보수용 에이전트에 직접 질문
- `/debug` 스킬 실행
- Discord 커뮤니티
