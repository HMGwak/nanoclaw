# NanoClaw 아키텍처 레퍼런스

> 작성일: 2026-03-27 | 기준 버전: 1.2.34 (upstream: qwibitai/nanoclaw)

---

## 1. 개요

NanoClaw는 **단일 Node.js 프로세스**로 동작하는 개인용 컨테이너형 AI 어시스턴트다. 메시징 채널(Discord, WhatsApp, Telegram, Slack, Gmail)에서 메시지를 수신하고, 각 그룹별로 **격리된 Linux 컨테이너** 안에서 선택한 에이전트 백엔드를 실행한 뒤, 응답을 다시 채널로 보낸다.

```
[Channels] → [SQLite DB] → [Polling Loop] → [Container (Agent Runner)] → [Response]
```

### 핵심 설계 원칙

- **이해 가능한 규모**: 소스 파일 ~15개, 전체 토큰 약 35k
- **컨테이너 격리**: 에이전트가 호스트 시스템에 직접 접근 불가. Docker 또는 Apple Container 사용
- **스킬 기반 확장**: 기능 추가는 코드 수정이 아니라 skill branch 병합으로 수행
- **설정 파일 없음**: 코드를 직접 수정하여 커스터마이징

### HMGwak 포크의 구조 계층

이 포크는 원본 NanoClaw와 크게 어긋나지 않기 위해, 다음 네 계층으로 구조를 나눈다.

1. `original_source/`
   원본 리포, 문서, 파이프라인 자산을 보존하는 read-mostly source of truth
2. `src/catalog/*`
   SDK 기반 profile, agent persona, reusable toolset, service-independent flow 정의
3. `src/services/*`
   Discord, Symphony 같은 실제 배포 서비스 계층. 필요한 agent/toolset/flow만 조합
4. `groups/*/AGENTS.md`
   실제 방 운영 규칙, 팀 역할, 말투, room semantics 같은 user-local policy

핵심 원칙:
- 서비스 계층은 조합만 하고 catalog의 사람/도구/flow 자체를 재정의하지 않는다.
- 공통 behavior는 코어 또는 재사용 계층에 두고, 서비스별 로직은 `src/services/*` 아래에 모은다.
- `.claude/*`는 호환 계층이며, 새로운 공통 설계 기준이 아니다.

---

## 2. 전체 데이터 흐름

### 2.1 인바운드 메시지 처리

```
1. 채널(Discord/Telegram/...)이 메시지 수신
2. onMessage 콜백 → storeMessage()로 SQLite에 저장
3. startMessageLoop() (2초 간격 폴링)
   ├─ getNewMessages()로 등록된 그룹의 새 메시지 조회
   ├─ 트리거 패턴 검사 (main 그룹은 항상 트리거 불필요)
   ├─ 활성 컨테이너 있으면 → IPC 파일로 메시지 전달 (queue.sendMessage)
   └─ 없으면 → GroupQueue에 enqueue → 새 컨테이너 생성
4. processGroupMessages()
   ├─ formatMessages()로 XML 형식 프롬프트 생성
   ├─ runContainerAgent()로 Docker 컨테이너 spawn
   ├─ 스트리밍 출력 파싱 (OUTPUT_START/END 마커)
   └─ channel.sendMessage()로 응답 전송
```

### 2.2 아웃바운드 응답

```
컨테이너 stdout → OUTPUT_START/END 마커 파싱 → JSON 추출
→ <internal> 태그 제거 → channel.sendMessage()
```

### 2.3 IPC (컨테이너 → 호스트)

```
컨테이너가 /workspace/ipc/messages/*.json 또는 /workspace/ipc/tasks/*.json 작성
→ 호스트 IPC Watcher (1초 간격) 가 data/ipc/{group}/ 폴링
→ 디렉토리 이름으로 그룹 ID 확인 (위변조 방지)
→ 권한 검증 후 실행 (메시지 전송, 태스크 생성 등)
```

---

## 3. main() 함수 실행 흐름 (`src/index.ts`)

```typescript
async function main(): Promise<void> {
  // 1. 컨테이너 런타임 확인 (Docker/Apple Container 실행 중인지)
  ensureContainerSystemRunning();

  // 2. SQLite DB 초기화
  initDatabase();

  // 3. 상태 복원 (마지막 타임스탬프, 세션, 등록된 그룹)
  loadState();

  // 4. OneCLI 에이전트 복구 (이전에 생성 실패한 것 재시도)
  for (const [jid, group] of registeredGroups) ensureOneCLIAgent(jid, group);

  // 5. Remote Control 세션 복원
  restoreRemoteControl();

  // 6. 시그널 핸들러 등록 (SIGTERM, SIGINT → graceful shutdown)
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 7. 채널 연결
  //    channels/index.ts에서 import 시 각 채널이 registerChannel() 호출
  //    → getRegisteredChannelNames()로 등록된 채널 순회
  //    → factory(channelOpts)로 채널 인스턴스 생성 (credential 없으면 null → skip)
  //    → channel.connect()로 연결
  for (const channelName of getRegisteredChannelNames()) {
    const channel = factory(channelOpts);
    if (channel) { channels.push(channel); await channel.connect(); }
  }

  // 8. 서브시스템 시작
  startSchedulerLoop(deps);    // 60초 간격 태스크 스케줄러
  startIpcWatcher(deps);       // 1초 간격 IPC 파일 감시
  queue.setProcessMessagesFn(processGroupMessages);

  // 9. 미처리 메시지 복구 (크래시 복구)
  recoverPendingMessages();

  // 10. 메시지 루프 시작 (2초 간격 무한 루프)
  startMessageLoop();
}
```

### 상태 관리 변수

| 변수 | 타입 | 용도 |
|------|------|------|
| `lastTimestamp` | `string` | 전체 메시지 폴링 커서 (마지막으로 확인한 타임스탬프) |
| `lastAgentTimestamp` | `Record<string, string>` | 그룹별 에이전트 처리 커서 |
| `sessions` | `Record<string, string>` | 그룹별 Claude 세션 ID |
| `registeredGroups` | `Record<string, RegisteredGroup>` | JID → 그룹 매핑 |
| `channels` | `Channel[]` | 활성 채널 인스턴스 배열 |
| `queue` | `GroupQueue` | 그룹별 작업 큐 (동시성 제어) |

---

## 4. 채널 시스템

### 4.1 채널 레지스트리 (`src/channels/registry.ts`)

```typescript
// 팩토리 패턴: 채널 모듈이 import 시 자동 등록
const registry = new Map<string, ChannelFactory>();

registerChannel('discord', (opts) => { ... });  // discord.ts 하단
registerChannel('telegram', (opts) => { ... }); // telegram.ts 하단 (skill로 추가)
```

`src/channels/index.ts`가 배럴 파일로, 설치된 채널 모듈을 import한다:

```typescript
import './discord.js';  // 현재 이 fork에 설치됨
// import './telegram.js';  // 주석 처리 = 미설치
```

### 4.2 Channel 인터페이스 (`src/types.ts`)

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;       // 이 채널이 해당 JID를 소유하는지
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

### 4.3 JID 포맷 (채널별)

| 채널 | JID 포맷 | 예시 |
|------|----------|------|
| Discord (primary) | `dc:{channelId}` | `dc:1234567890123456` |
| Discord (secondary bot) | `dc:{channelId}:{botLabel}` | `dc:1234567890123456:workshop` |
| WhatsApp (개인) | `{number}@s.whatsapp.net` | `821012345678@s.whatsapp.net` |
| WhatsApp (그룹) | `{id}@g.us` | `120363336345536173@g.us` |
| Telegram | `tg:{chatId}` | `tg:-1001234567890` |
| Slack | `sl:{channelId}` | `sl:C07ABCDEF12` |

---

## 5. Discord 통합 상세 (`src/channels/discord.ts`)

### 5.1 아키텍처

```
DiscordChannel
├── bots: BotClient[]           # 복수 봇 지원
│   ├── primary (DISCORD_BOT_TOKEN)
│   ├── workshop (DISCORD_BOT_TOKEN_WORKSHOP)
│   └── research (DISCORD_BOT_TOKEN_RESEARCH)
├── setupMessageHandler()       # 봇별 메시지 핸들러
├── connect()                   # 모든 봇 병렬 로그인
├── sendMessage()               # JID로 봇 선택 → 메시지 전송
└── ownsJid()                   # dc: 프리픽스 매칭
```

### 5.2 멀티봇 시스템

NanoClaw Discord는 **복수 봇을 동시에 운영**할 수 있다:

1. **Primary 봇**: `DISCORD_BOT_TOKEN`으로 설정. JID = `dc:{channelId}`
2. **Secondary 봇**: `DISCORD_BOT_TOKEN_{LABEL}` (예: `DISCORD_BOT_TOKEN_WORKSHOP`)
   - JID = `dc:{channelId}:{label}` (예: `dc:123456:workshop`)
   - **해당 봇이 @mention될 때만 반응** (primary는 다른 봇이 mention 안 되면 기본 처리)

### 5.3 메시지 수신 흐름

```
Discord Gateway → Events.MessageCreate
├── bot 메시지 무시 (message.author.bot)
├── @mention 감지 (message.mentions.users.has(botId))
├── JID 결정:
│   ├── primary: dc:{channelId}
│   └── secondary: dc:{channelId}:{botLabel}
├── secondary 봇: @mention 안 되면 return
├── primary 봇: 다른 secondary 봇이 mention되면 return
├── @mention → 트리거 형식으로 변환 (예: "@Andy 안녕" → "@비서실 안녕")
├── 첨부파일 처리: [Image: name], [Video: name], [File: name]
├── 답장 컨텍스트: [Reply to {author}] {content}
├── 미등록 채널이면 무시
└── onMessage 콜백 호출 → SQLite 저장
```

### 5.4 메시지 전송

```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  // JID에서 봇 선택 (dc:channelId:botLabel → 해당 봇)
  const bot = this.getBotForJid(jid);
  const channelId = jid.replace(/^dc:/, '').split(':')[0];
  const channel = await bot.client.channels.fetch(channelId);

  // Discord 2000자 제한 → 자동 분할
  if (text.length <= 2000) await channel.send(text);
  else for (let i = 0; i < text.length; i += 2000) await channel.send(text.slice(i, i + 2000));
}
```

### 5.5 필요한 Gateway Intents

```typescript
GatewayIntentBits.Guilds           // 서버 정보
GatewayIntentBits.GuildMessages    // 서버 메시지
GatewayIntentBits.MessageContent   // 메시지 본문 읽기 (필수!)
GatewayIntentBits.DirectMessages   // DM 수신
```

### 5.6 Discord Developer Portal 설정

1. Application 생성 → Bot 탭에서 토큰 생성
2. **Message Content Intent** 활성화 (필수)
3. **Server Members Intent** 활성화 (displayName용, 선택)
4. OAuth2 → URL Generator → 권한: `Send Messages`, `Read Message History`, `View Channels`
5. 생성된 URL로 서버에 봇 초대

### 5.7 환경 변수

```bash
# 필수
DISCORD_BOT_TOKEN=your-primary-bot-token

# 선택 (멀티봇)
DISCORD_BOT_TOKEN_WORKSHOP=secondary-bot-token-1
DISCORD_BOT_TOKEN_RESEARCH=secondary-bot-token-2
DISCORD_BOT_TOKEN_SUPPORT=secondary-bot-token-3
DISCORD_BOT_TOKEN_ADMIN=secondary-bot-token-4
```

---

## 6. 컨테이너 시스템

### 6.1 볼륨 마운트 구조

**Main 그룹:**
```
호스트                              → 컨테이너
{project-root}/                    → /workspace/project     (읽기 전용)
{project-root}/.env                → /workspace/project/.env (/dev/null로 섀도잉!)
groups/main/                       → /workspace/group        (읽기+쓰기)
data/sessions/{folder}/.claude/    → /home/node/.claude      (읽기+쓰기)
data/sessions/{folder}/.nanoclaw/  → /home/node/.nanoclaw    (읽기+쓰기)
data/ipc/{folder}/                 → /workspace/ipc          (읽기+쓰기)
data/sessions/{folder}/agent-runner-src/ → /app/src           (읽기+쓰기)
```

**일반 그룹:**
```
groups/{folder}/                   → /workspace/group        (읽기+쓰기)
groups/global/                     → /workspace/global       (읽기 전용)
data/sessions/{folder}/.claude/    → /home/node/.claude      (읽기+쓰기)
data/sessions/{folder}/.nanoclaw/  → /home/node/.nanoclaw    (읽기+쓰기)
data/ipc/{folder}/                 → /workspace/ipc          (읽기+쓰기)
data/sessions/{folder}/agent-runner-src/ → /app/src           (읽기+쓰기)
+ containerConfig.additionalMounts (allowlist 검증 후)
```

### 6.2 보안 모델

- `.env` 파일은 `/dev/null`로 마운트하여 컨테이너에서 접근 불가
- Claude 백엔드는 OneCLI 게이트웨이로, 나머지 백엔드는 호스트가 읽은 자격증명을 환경변수로 전달
- IPC 디렉토리 경로로 그룹 ID 확인 (파일 내용이 아님)
- main 그룹만 `register_group`, `refresh_groups` 가능
- 비-main 그룹은 자기 그룹의 태스크만 조작 가능
- `mount-allowlist.json`은 `~/.config/nanoclaw/`에 저장 (컨테이너 밖)

### 6.3 에이전트 백엔드

```typescript
type AgentBackend =
  | 'openai'
  | 'opencode'
  | 'zai'
  | 'openai-compat'
  | 'claude';
```

| 백엔드 | 크레덴셜 | 용도 |
|--------|----------|------|
| `openai` (기본) | `OPENAI_API_KEY` | OpenAI API |
| `opencode` | `OPENCODE_API_KEY` + `OPENCODE_MODEL` | OpenCode Go SDK (kimi-k2.5 등) |
| `zai` | `ZAI_API_KEY` + `ZAI_MODEL` | Z.AI / GLM |
| `openai-compat` | `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL` | 기타 OpenAI 호환 API |
| `claude` | OneCLI 게이트웨이 | Anthropic API, Claude Code |

`AGENT_BACKEND`를 지정하지 않으면 `openai -> opencode -> zai -> openai-compat -> claude` 순으로 자동 감지한다. 그룹별 `containerConfig.backend`로도 override 가능.

### 6.4 컨테이너 출력 파싱

```
stdout: ... ---NANOCLAW_OUTPUT_START--- {"status":"success","result":"응답 텍스트"} ---NANOCLAW_OUTPUT_END--- ...
```

- 스트리밍 모드: 마커 쌍이 도착할 때마다 실시간 파싱 → 즉시 채널로 전송
- 레거시 모드: 컨테이너 종료 후 마지막 마커 쌍에서 JSON 추출

---

## 7. GroupQueue (`src/group-queue.ts`)

### 동시성 제어

```
MAX_CONCURRENT_CONTAINERS = 5 (기본값, 환경변수로 조정 가능)

그룹별 상태:
├── active: boolean           # 컨테이너 실행 중
├── idleWaiting: boolean      # 에이전트가 작업 완료 후 대기 중
├── isTaskContainer: boolean  # 스케줄 태스크용 컨테이너인지
├── pendingMessages: boolean  # 대기 중인 메시지 있는지
├── pendingTasks: QueuedTask[]# 대기 중인 태스크 배열
└── retryCount: number        # 재시도 횟수 (max 5, 지수 백오프)
```

### 작업 흐름

```
enqueueMessageCheck(groupJid)
├── 활성 컨테이너 있으면 → pendingMessages = true (나중에 drain)
├── 동시성 한도 도달 → waitingGroups에 추가
└── 여유 있으면 → runForGroup() 즉시 실행

컨테이너 종료 시:
drainGroup(groupJid)
├── pendingTasks 있으면 → runTask() (태스크 우선)
├── pendingMessages 있으면 → runForGroup()
└── 없으면 → drainWaiting() (대기 중인 다른 그룹 처리)
```

### Follow-up 메시지 (활성 컨테이너에 전달)

```
queue.sendMessage(chatJid, text)
→ data/ipc/{group}/input/{timestamp}.json 작성
→ 컨테이너 내 agent-runner가 input/ 디렉토리 폴링 (500ms)
→ 새 메시지 감지 → 에이전트에 전달
```

### Idle Timeout

- 에이전트가 결과를 보낸 후 30분(`IDLE_TIMEOUT`) 동안 새 입력 없으면
- `_close` sentinel 파일 작성 → 컨테이너 종료
- 새 태스크가 들어오면 idle 컨테이너를 즉시 종료하고 태스크용 컨테이너 시작

---

## 8. IPC MCP 서버 (`container/agent-runner/src/ipc-mcp-stdio.ts`)

컨테이너 안에서 실행되는 MCP 서버로, 에이전트에게 다음 도구를 제공:

| 도구 | 설명 | 권한 |
|------|------|------|
| `send_message` | 사용자/그룹에 즉시 메시지 전송 | 모두 |
| `schedule_task` | 반복/일회성 태스크 예약 | 모두 (cross-group은 main만) |
| `list_tasks` | 예약된 태스크 목록 조회 | 모두 (main은 전체, 일반은 자기 것만) |
| `pause_task` | 태스크 일시정지 | 소유 그룹 또는 main |
| `resume_task` | 태스크 재개 | 소유 그룹 또는 main |
| `cancel_task` | 태스크 삭제 | 소유 그룹 또는 main |
| `update_task` | 태스크 수정 | 소유 그룹 또는 main |
| `register_group` | 새 그룹 등록 | main만 |

---

## 9. 태스크 스케줄러 (`src/task-scheduler.ts`)

```
60초 간격 폴링 → getDueTasks() → GroupQueue에 enqueue

스케줄 타입:
├── cron: "0 9 * * *" (매일 9시, 로컬 타임존)
├── interval: "3600000" (1시간마다, 밀리초)
└── once: "2026-03-28T15:30:00" (일회성, 로컬 시간, Z 접미사 금지)

context_mode:
├── group: 기존 대화 세션에서 실행 (이전 대화 기억)
└── isolated: 새 세션에서 실행 (독립적)
```

태스크 완료 후 `computeNextRun()`으로 다음 실행 시간 계산. interval은 예정 시간 기준으로 앵커링하여 누적 드리프트 방지.

---

## 10. 그룹 등록과 AGENTS.md

### 그룹 등록 시

```typescript
registerGroup(jid, group):
  1. resolveGroupFolderPath()로 경로 검증
  2. groups/{folder}/logs/ 디렉토리 생성
  3. groups/{folder}/AGENTS.md 없으면 템플릿 복사:
     ├── main 그룹: groups/main/AGENTS.md
     └── 일반 그룹: groups/global/AGENTS.md
  4. ASSISTANT_NAME이 'Andy'가 아니면 템플릿 내 이름 치환
  5. OneCLI 에이전트 생성 (비동기, best-effort)
  6. DB에 저장
```

### 그룹 디렉토리 구조

```
groups/
├── main/           # 메인 채널 (관리자)
│   └── AGENTS.md   # 메인 그룹 에이전트 지시사항
├── global/         # 공용 템플릿
│   └── AGENTS.md   # 일반 그룹에 복사되는 템플릿
└── discord_general/  # 등록된 그룹 예시
    ├── AGENTS.md   # 이 그룹 전용 메모리
    └── logs/       # 컨테이너 실행 로그
```

---

## 11. 트리거 시스템

```typescript
DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;  // 기본: "@Andy"
TRIGGER_PATTERN = /^@Andy\b/i;           // 대소문자 무시, 단어 경계

// 그룹별 커스텀 트리거 가능:
// group.trigger = "@비서" → /^@비서\b/i
```

- **main 그룹**: 트리거 불필요 (모든 메시지 처리)
- **일반 그룹**: 트리거 매칭되는 메시지가 있을 때만 에이전트 호출
- **트리거 없는 메시지**: DB에 저장되어, 다음 트리거 시 컨텍스트로 포함됨
- **sender-allowlist**: 특정 사용자만 트리거 가능하도록 제한 가능

---

## 12. 파일 시스템 구조 종합

```
nanoclaw/
├── src/
│   ├── index.ts              # 메인 오케스트레이터
│   ├── channels/
│   │   ├── index.ts          # 채널 배럴 파일
│   │   ├── registry.ts       # 채널 팩토리 레지스트리
│   │   └── discord.ts        # Discord 채널 구현 (멀티봇)
│   ├── config.ts             # 설정값 (트리거, 경로, 타임아웃)
│   ├── types.ts              # 핵심 타입 정의
│   ├── router.ts             # 메시지 포맷팅, 채널 라우팅
│   ├── container-runner.ts   # 컨테이너 spawn, 볼륨 마운트, 출력 파싱
│   ├── container-runtime.ts  # Docker/Apple Container 런타임 관리
│   ├── group-queue.ts        # 그룹별 동시성 큐
│   ├── ipc.ts                # 호스트측 IPC 파일 감시
│   ├── task-scheduler.ts     # 스케줄 태스크 실행
│   ├── db.ts                 # SQLite 데이터베이스 (메시지, 세션, 그룹, 태스크)
│   ├── agent-backend.ts      # 에이전트 백엔드 설정 (openai/opencode/zai/openai-compat/claude)
│   ├── mount-security.ts     # 마운트 allowlist 검증
│   ├── sender-allowlist.ts   # 발신자 허용 목록
│   ├── remote-control.ts     # 원격 제어 세션
│   └── logger.ts             # pino 로거
├── container/
│   ├── agent-runner/src/
│   │   └── ipc-mcp-stdio.ts  # 컨테이너 내 MCP 서버 (send_message, schedule_task 등)
│   ├── skills/               # 컨테이너 안에서 로드되는 스킬
│   └── build.sh              # 컨테이너 이미지 빌드
├── groups/                   # 그룹별 디렉토리 (AGENTS.md, logs/)
├── data/
│   ├── sessions/             # 그룹별 Claude 세션 (.claude/, agent-runner-src/)
│   └── ipc/                  # IPC 파일 (messages/, tasks/, input/)
├── store/                    # SQLite DB 파일
├── .claude/skills/           # 호스트측 Claude Code 스킬
└── .env                      # 환경변수 (토큰, 백엔드 설정)
```

---

## 13. 주요 설정값

| 상수 | 기본값 | 설명 |
|------|--------|------|
| `POLL_INTERVAL` | 2000ms | 메시지 폴링 간격 |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | 태스크 스케줄러 폴링 간격 |
| `IPC_POLL_INTERVAL` | 1000ms | IPC 파일 감시 간격 |
| `IDLE_TIMEOUT` | 1800000ms (30분) | 컨테이너 유휴 타임아웃 |
| `CONTAINER_TIMEOUT` | 1800000ms (30분) | 컨테이너 하드 타임아웃 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | 최대 동시 컨테이너 수 |
| `CONTAINER_MAX_OUTPUT_SIZE` | 10MB | stdout/stderr 최대 크기 |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Docker 이미지 이름 |
| `ASSISTANT_NAME` | `Andy` | 어시스턴트 이름 |

---

## 14. 이 Fork의 특이사항 (HMGwak)

- **Discord 채널 통합 완료**: `skill/discord` 브랜치가 merge됨 (`980cadb`)
- **멀티 백엔드 지원**: OpenCode, OpenAI-compat 백엔드 추가 (`f7b504e`)
- **Git Remotes**:
  - `origin` → `HMGwak/nanoclaw` (내 fork)
  - `upstream` → `qwibitai/nanoclaw` (원본)
  - `discord` → `qwibitai/nanoclaw-discord` (Discord 전용)
  - `nasen` → `Nasen/nanoclaw` (다른 fork)
