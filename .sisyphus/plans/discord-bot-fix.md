# Discord 봇 오프라인 문제 해결 계획

## 현상
리팩토링 후 Discord 봇들이 오프라인 상태. 리팩토링 전에는 정상 작동.

## 분석

### 현재 아키텍처 구조

```
src/services/discord/
├── bots.ts              # 봇 토큰 로딩 (환경 변수 스캔)
├── personnel.ts         # 페르소나 정의 (displayName, catalogAgentId)
├── bindings/groups.ts   # 그룹 바인딩 (senderBotMap 정의)
├── deployments.ts       # 배포 스펙 변환
├── index.ts             # 배럴 익스포트
└── ...

src/channels/discord.ts  # Discord 채널, connect()에서 loadDiscordServiceBots() 호출
```

### 문제 지점

**1. `bots.ts`의 `loadDiscordServiceBots()`가 고립됨**

```typescript
// src/services/discord/bots.ts:17-35
export function loadDiscordServiceBots(): AdditionalDiscordBotConfig[] {
  const envFileContent = readEnvFile(DISCOVERED_TOKEN_KEYS);  // ← 고정된 키 목록
  const allEnv = { ...envFileContent, ...process.env };
  const bots: AdditionalDiscordBotConfig[] = [];

  for (const [key, value] of Object.entries(allEnv)) {
    if (
      key.startsWith('DISCORD_BOT_TOKEN_') &&
      value &&
      key !== 'DISCORD_BOT_TOKEN'
    ) {
      bots.push({
        label: key.replace('DISCORD_BOT_TOKEN_', '').toLowerCase(),
        token: value,
      });
    }
  }
  return bots;
}
```

- `DISCOVERED_TOKEN_KEYS`가 하드코딩됨 (`WORKSHOP`, `KIMI`, `RESEARCH`...)
- `bindings/groups.ts`의 `senderBotMap`을 참조하지 않음
- 결과: 새로운 봇 label이 추가되어도 인식하지 못함

**2. `senderBotMap`은 메시지 라우팅에만 사용**

```typescript
// src/services/discord/bindings/groups.ts:21-27
{
  id: 'discord-workshop',
  senderBotMap: {
    '작업실 팀장': 'workshop',  // ← 이 매핑이 봇 초기화에는 사용되지 않음
    '키미': 'kimi',
  },
}
```

- `senderBotMap`은 `sendMessage()` 시점에 persona → bot 매핑에만 사용
- 봇 초기화 시 어떤 봇이 필요한지 결정하는 데는 사용되지 않음

**3. `connect()`의 로그인 실패 처리**

```typescript
// src/channels/discord.ts:305-330
await Promise.all(connectPromises);  // ← 하나라도 실패/무한대기 시 전체 블록
```

- `login()` 실패 시 `ClientReady` 이벤트가 오지 않음
- 일부 토큰이 잘못되면 전체 연결이 멈춤

## 해결 방안

### 옵션 1: `bots.ts`가 `bindings`를 참조 (권장)

**구조 변경 없이 기존 파일들의 관계만 수정**

```typescript
// src/services/discord/bots.ts
import { listDiscordGroupBindings } from './bindings/groups.js';

export function loadDiscordServiceBots(): AdditionalDiscordBotConfig[] {
  // 1. bindings에서 필요한 모든 bot label 수집
  const requiredLabels = new Set<string>();
  for (const binding of listDiscordGroupBindings()) {
    if (binding.senderBotMap) {
      Object.values(binding.senderBotMap).forEach(label => requiredLabels.add(label));
    }
  }
  
  // 2. 환경 변수에서 해당 label의 토큰 찾기
  const envFileContent = readEnvFile([...requiredLabels.map(l => `DISCORD_BOT_TOKEN_${l.toUpperCase()}`)]);
  const allEnv = { ...envFileContent, ...process.env };
  
  const bots: AdditionalDiscordBotConfig[] = [];
  for (const label of requiredLabels) {
    const key = `DISCORD_BOT_TOKEN_${label.toUpperCase()}`;
    const token = allEnv[key];
    if (token) {
      bots.push({ label, token });
    } else {
      logger.warn(`Discord bot token missing for label: ${label}`);
    }
  }
  
  return bots;
}
```

**장점:**
- 기존 파일 구조 유지
- `bindings/groups.ts`가 단일 소스 오브 트루스가 됨
- personnel 리팩토링의 의도대로 작동

### 옵션 2: `connect()` 개선 (추가)

```typescript
// src/channels/discord.ts:305-330
const connectPromises = this.bots.map(
  (bot) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Bot ${bot.label} login timeout`));
      }, 30000);
      
      bot.client.once(Events.ClientReady, (readyClient) => {
        clearTimeout(timeout);
        bot.botUserId = readyClient.user.id;
        logger.info({ username: readyClient.user.tag, label: bot.label }, 'Discord bot connected');
        resolve();
      });
      
      bot.client.login(bot.token).catch(err => {
        clearTimeout(timeout);
        logger.error({ err, label: bot.label }, 'Discord bot login failed');
        reject(err);
      });
    }),
);

// Promise.all → Promise.allSettled로 변경
const results = await Promise.allSettled(connectPromises);
const failures = results.filter(r => r.status === 'rejected');
if (failures.length > 0) {
  logger.error({ failureCount: failures.length }, 'Some Discord bots failed to connect');
}
```

## 구현 계획

### Phase 1: `bots.ts` 수정

**파일:** `src/services/discord/bots.ts`

**변경사항:**
1. `listDiscordGroupBindings` import 추가
2. `loadDiscordServiceBots()` 구현 변경:
   - `listDiscordGroupBindings()` 호출
   - 모든 `senderBotMap`의 value 수집
   - 해당 label에 대한 토큰만 로드
3. 하드코딩된 `DISCOVERED_TOKEN_KEYS` 제거 (또는 폴백으로 유지)

### Phase 2: `connect()` 개선

**파일:** `src/channels/discord.ts`

**변경사항:**
1. `login()`에 timeout 추가
2. `Promise.all` → `Promise.allSettled`로 변경
3. 개별 봇 연결 실패 로깅

### Phase 3: 디버깅 로그 추가

**파일:** `src/channels/discord.ts`, `src/services/discord/bots.ts`

**추가 로그:**
- `registerChannel` 콜백에서 primary 토큰 존재 여부
- `loadDiscordServiceBots()`에서 수집된 label 목록
- 각 봇 로그인 시작/성공/실패

## 검증 방법

1. 빌드: `npm run build`
2. 타입체크: `npm run typecheck`
3. 테스트: `npm test -- src/channels/discord.test.ts`
4. 실행 테스트: NanoClaw 실행 후 Discord 봇 상태 확인

## 롤백 계획

문제 발생 시 `git checkout HEAD -- src/services/discord/bots.ts src/channels/discord.ts`로 롤백 가능

## 참고

- 이 변경은 기존 아키텍처를 유지하면서 `bots.ts`와 `bindings/groups.ts`를 연결하는 것
- personnel 리팩토링의 의도(그룹 바인딩 기반 설정)를 완성하는 마지막 단계
