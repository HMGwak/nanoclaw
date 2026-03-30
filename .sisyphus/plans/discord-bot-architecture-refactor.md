# Discord 봇 구조 리팩토링 계획 (아키텍처 플랜 준수)

## 현재 구조의 문제

### 아키텍처 위반 사항

**1. personnel.ts가 service-local 리소스를 담당하지 않음**

```typescript
// 현재: personnel.ts - 봇 정보 없음
export interface DiscordPersonnelSpec {
  id: string;
  displayName: string;
  catalogAgentId: string;
  localToolsetIds: string[];
  flowIds: string[];
  role?: string;
  // ❌ botTokenKey 없음
  // ❌ botLabel 없음
}
```

**2. bindings/groups.ts가 하드코딩된 senderBotMap 사용**

```typescript
// 현재: binding이 직접 label 매핑
senderBotMap: {
  '작업실 팀장': 'workshop',  // ← personnel ID가 아닌 직접 label
  '키미': 'kimi',
}
```

**3. bots.ts가 binding을 직접 참조 (personnel 우회)**

```typescript
// 현재: personnel을 거치지 않고 binding에서 직접 로드
for (const binding of listDiscordGroupBindings()) {
  if (!binding.senderBotMap) continue;
  for (const label of Object.values(binding.senderBotMap)) {
    // ❌ personnel 참조 없음
  }
}
```

## 아키텍처 플랜 준수 구조

### 목표 구조

```
src/services/discord/
├── resources/
│   ├── personnel.ts     # ← personnel이 봇 정보 포함
│   └── toolsets.ts
├── bindings/
│   └── groups.ts        # ← personnel ID만 참조
├── bots.ts              # ← personnel을 통해 봇 로드
└── ...
```

### 데이터 흐름

```
bindings/groups.ts
    senderPersonnelMap: {
      '작업실 팀장': 'discord_workshop_teamlead',  // ← personnel ID
      '키미': 'discord_workshop_kimi',
    }
    ↓
personnel.ts
    discord_workshop_teamlead: {
      displayName: '작업실 팀장',
      catalogAgentId: 'openai_gpt54_planner',
      botConfig: {                    // ← 추가
        label: 'workshop',
        tokenKey: 'DISCORD_BOT_TOKEN_WORKSHOP'
      }
    }
    ↓
bots.ts
    loadDiscordServiceBots() {
      // personnel을 통해 봇 로드
      for (const personnel of listDiscordPersonnelSpecs()) {
        if (personnel.botConfig) {
          const token = env[personnel.botConfig.tokenKey];
          bots.push({
            label: personnel.botConfig.label,
            token: token
          });
        }
      }
    }
```

## 구현 단계

### Phase 1: personnel.ts 수정

**파일:** `src/services/discord/resources/personnel.ts`

**변경사항:**
1. `DiscordBotConfig` 인터페이스 추가
2. `DiscordPersonnelSpec`에 `botConfig?: DiscordBotConfig` 추가
3. 각 personnel에 해당하는 botConfig 추가

```typescript
export interface DiscordBotConfig {
  label: string;        // 봇 식별자 (workshop, kimi 등)
  tokenKey: string;     // .env 키 (DISCORD_BOT_TOKEN_WORKSHOP 등)
}

export interface DiscordPersonnelSpec {
  id: string;
  displayName: string;
  catalogAgentId: string;
  localToolsetIds: string[];
  flowIds: string[];
  role?: string;
  botConfig?: DiscordBotConfig;  // ← 추가
}

// 데이터 업데이트
const DISCORD_PERSONNEL: Record<string, DiscordPersonnelSpec> = {
  discord_workshop_teamlead: {
    id: 'discord_workshop_teamlead',
    displayName: '작업실 팀장',
    catalogAgentId: 'openai_gpt54_planner',
    localToolsetIds: ['discord_workshop_lead_local'],
    flowIds: ['planning-workshop'],
    role: 'Workshop team lead',
    botConfig: {                          // ← 추가
      label: 'workshop',
      tokenKey: 'DISCORD_BOT_TOKEN_WORKSHOP'
    }
  },
  discord_workshop_kimi: {
    id: 'discord_workshop_kimi',
    displayName: '키미',
    catalogAgentId: 'opencode_kimi_k25_researcher',
    localToolsetIds: ['discord_workshop_research_local'],
    flowIds: ['planning-workshop'],
    role: 'Workshop implementation and research teammate',
    botConfig: {                          // ← 추가
      label: 'kimi',
      tokenKey: 'DISCORD_BOT_TOKEN_KIMI'
    }
  },
  // ... 나머지 personnel도 동일하게 업데이트
};
```

### Phase 2: bindings/groups.ts 수정

**파일:** `src/services/discord/bindings/groups.ts`

**변경사항:**
1. `senderBotMap` → `senderPersonnelMap`으로 변경
2. value를 봇 label 대신 personnel ID로 변경

```typescript
export interface DiscordGroupBindingSpec {
  id: string;
  departmentId: 'workshop' | 'planning' | 'secretary';
  groupFolders: string[];
  leadPersonnelId: string;
  teammatePersonnelIds: string[];
  flowIds: string[];
  senderPersonnelMap?: Record<string, string>;  // ← senderBotMap → senderPersonnelMap
  personaMode?: 'hybrid' | 'bot_only';
  canStartWorkflow?: boolean;
}

const DISCORD_GROUP_BINDINGS: DiscordGroupBindingSpec[] = [
  {
    id: 'discord-workshop',
    departmentId: 'workshop',
    groupFolders: ['discord_workshop'],
    leadPersonnelId: 'discord_workshop_teamlead',
    teammatePersonnelIds: ['discord_workshop_kimi'],
    flowIds: ['planning-workshop'],
    senderPersonnelMap: {                           // ← senderBotMap → senderPersonnelMap
      '작업실 팀장': 'discord_workshop_teamlead',   // ← 봇 label 대신 personnel ID
      '키미': 'discord_workshop_kimi',
    },
    personaMode: 'bot_only',
  },
  // ... 나머지 binding도 동일하게 업데이트
];
```

### Phase 3: bots.ts 수정

**파일:** `src/services/discord/bots.ts`

**변경사항:**
1. `listDiscordGroupBindings` import 제거
2. `listDiscordPersonnelSpecs` import 추가
3. `loadDiscordServiceBots()`가 personnel을 통해 봇 로드

```typescript
import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import { listDiscordPersonnelSpecs } from './resources/personnel.js';  // ← 변경

export interface AdditionalDiscordBotConfig {
  label: string;
  token: string;
}

export function loadDiscordServiceBots(): AdditionalDiscordBotConfig[] {
  const bots: AdditionalDiscordBotConfig[] = [];
  const processedLabels = new Set<string>();

  // personnel을 통해 봇 설정 수집
  for (const personnel of listDiscordPersonnelSpecs()) {
    if (!personnel.botConfig) continue;
    
    const { label, tokenKey } = personnel.botConfig;
    
    // 중복 방지
    if (processedLabels.has(label)) {
      logger.warn({ label, personnelId: personnel.id }, 'Duplicate bot label found');
      continue;
    }
    processedLabels.add(label);
    
    // 환경 변수에서 토큰 로드
    const envFileContent = readEnvFile([tokenKey]);
    const allEnv = { ...envFileContent, ...process.env };
    const token = allEnv[tokenKey];
    
    if (token) {
      bots.push({ label, token });
      logger.debug({ label, personnelId: personnel.id }, 'Discord bot loaded from personnel');
    } else {
      logger.warn({ label, tokenKey, personnelId: personnel.id }, 'Discord bot token missing');
    }
  }

  logger.debug(
    { botCount: bots.length, labels: bots.map(b => b.label) },
    'Discord service bots loaded from personnel'
  );

  return bots;
}
```

### Phase 4: personas.ts 수정

**파일:** `src/services/discord/personas.ts`

**변경사항:**
1. `senderPersonnelMap`을 참조하도록 수정
2. personnel ID로 봇 label을 조회

```typescript
import { getDiscordPersonnelSpec } from './resources/personnel.js';
import { getDiscordGroupBindingForGroup } from './bindings/groups.js';

export function resolveDiscordPersonaBotLabel(
  group: RegisteredGroup | undefined,
  sender?: string,
): string | null {
  if (!group || !sender) return null;
  
  const binding = getDiscordGroupBindingForGroup(group);
  if (!binding?.senderPersonnelMap) return null;  // ← senderBotMap → senderPersonnelMap
  
  const personnelId = binding.senderPersonnelMap[sender];
  if (!personnelId) return null;
  
  // personnel에서 bot label 조회
  const personnel = getDiscordPersonnelSpec(personnelId);
  if (!personnel?.botConfig) return null;
  
  return personnel.botConfig.label;
}
```

### Phase 5: deployments.ts 수정 (타입 업데이트)

**파일:** `src/services/discord/deployments.ts`

**변경사항:**
1. `DiscordServiceDeploymentSpec`에 `senderPersonnelMap` 추가
2. `toDeploymentSpec` 변환 로직 업데이트

```typescript
export interface DiscordServiceDeploymentSpec {
  id: string;
  departmentId: 'workshop' | 'planning' | 'secretary';
  groupFolders: string[];
  leadPersonnelId: string;
  teammatePersonnelIds: string[];
  flowIds: string[];
  senderPersonnelMap?: Record<string, string>;  // ← senderBotMap → senderPersonnelMap
  senderBotMap?: Record<string, string>;        // ← backwards compatibility (deprecated)
  personaMode?: 'hybrid' | 'bot_only';
  canStartWorkflow?: boolean;
}

function toDeploymentSpec(binding: ...): DiscordServiceDeploymentSpec | null {
  if (!binding) return null;
  return {
    id: binding.id,
    departmentId: binding.departmentId,
    groupFolders: [...binding.groupFolders],
    leadPersonnelId: binding.leadPersonnelId,
    teammatePersonnelIds: [...binding.teammatePersonnelIds],
    flowIds: [...binding.flowIds],
    senderPersonnelMap: binding.senderPersonnelMap,  // ← 추가
    personaMode: binding.personaMode,
    canStartWorkflow: binding.canStartWorkflow,
  };
}
```

### Phase 6: types.ts 수정

**파일:** `src/services/discord/types.ts`

**변경사항:**
1. `senderPersonnelMap` 필드 추가
2. `senderBotMap`은 deprecated로 표시

```typescript
export interface DiscordServiceDeploymentSpec {
  id: string;
  departmentId: 'workshop' | 'planning' | 'secretary';
  groupFolders: string[];
  leadPersonnelId: string;
  teammatePersonnelIds: string[];
  flowIds: string[];
  senderPersonnelMap?: Record<string, string>;  // ← personnel ID 매핑
  senderBotMap?: Record<string, string>;        // ← deprecated (for backwards compat)
  personaMode?: 'hybrid' | 'bot_only';
  canStartWorkflow?: boolean;
}
```

## 검증 방법

1. **타입체크:** `npm run typecheck`
2. **테스트:** `npm test -- src/channels/discord.test.ts`
3. **빌드:** `npm run build`
4. **실행 테스트:** 
   - NanoClaw 실행
   - Discord 봇 연결 확인
   - 메시지 송수신 테스트

## 롤백 계획

```bash
git checkout HEAD -- src/services/discord/
```

## 아키텍처 정합성 검증 체크리스트

- [ ] personnel.ts가 봇 설정을 포함하는가?
- [ ] bindings/groups.ts가 personnel ID만 참조하는가?
- [ ] bots.ts가 personnel을 통해 봇을 로드하는가?
- [ ] personas.ts가 personnel을 통해 봇 label을 조회하는가?
- [ ] senderBotMap이 senderPersonnelMap으로 변경되었는가?
- [ ] Backwards compatibility가 유지되는가? (선택적)
