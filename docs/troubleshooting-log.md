# NanoClaw Troubleshooting Log

## 2026-03-26: OpenCode SDK 백엔드 통합

### 배경
NanoClaw의 에이전트 백엔드를 Claude Agent SDK에서 OpenCode SDK로 전환하는 작업.
OpenCode Go 구독(kimi-k2.5 모델) 사용.

---

### 문제 1: Docker 빌드 시 키체인 접근 에러

**증상:**
```
ERROR: error getting credentials - err: exit status 1, out: `keychain cannot be accessed
because the current session does not allow user interaction.`
```

**원인:**
`~/.docker/config.json`의 `"credsStore": "desktop"` 설정이 Docker Desktop의 credential helper(`docker-credential-desktop`)를 통해 macOS 키체인에 접근하려 함. Claude Code 같은 비대화형 세션에서는 키체인 잠금 해제가 불가능.

**시도한 해결:**
1. `credsStore` 값 삭제 → Docker Desktop 재시작 시 원복됨
2. `credsStore`를 빈 문자열로 설정 → Docker buildkit이 캐시된 credential helper를 계속 사용
3. `security unlock-keychain` → 비밀번호 인증 필요, 비대화형 세션에서 불가

**최종 해결:**
임시 Docker config 파일로 빌드:
```bash
DOCKER_CONFIG=/tmp/docker-no-creds
mkdir -p $DOCKER_CONFIG
echo '{"auths":{}}' > $DOCKER_CONFIG/config.json
DOCKER_CONFIG=$DOCKER_CONFIG docker build -t nanoclaw-agent:latest container/
```
`credsStore`와 `currentContext`가 모두 없는 깨끗한 config를 사용하여 credential helper를 완전 우회.

**핵심 교훈:**
- Docker Desktop은 `~/.docker/config.json`을 재시작 시 자동 복원함
- buildkit daemon은 config를 캐시하므로 `docker buildx stop`으로 재시작 필요
- 가장 확실한 방법은 `DOCKER_CONFIG` 환경변수로 별도 config 사용

---

### 문제 2: OpenCode 서버가 HTML 반환 (JSON 파싱 에러)

**증상:**
```
OpenCode error: Unexpected token '<', "<!doctype "... is not valid JSON
```

**원인:**
agent-runner 소스 코드가 `data/sessions/discord_main/agent-runner-src/`에 캐시됨. 코드를 수정해도 캐시된 옛 코드가 컨테이너에 마운트되어 계속 사용됨.

옛 코드는 raw HTTP로 OpenCode 서버의 루트 경로(`/session/create`)를 호출했는데, 이 경로가 API가 아닌 웹 UI HTML을 반환.

**해결:**
```bash
rm -rf data/sessions/discord_main/agent-runner-src
```
캐시 삭제 후 NanoClaw 재시작하면 새 코드가 복사됨.

**핵심 교훈:**
- NanoClaw은 agent-runner 소스를 그룹별 세션 디렉토리에 캐시함
- `container/agent-runner/src/` 수정 후에는 반드시 캐시 삭제 필요
- 또는 `src/container-runner.ts`의 staleness 체크가 새 파일(types.ts 등)도 포함하는지 확인

---

### 문제 3: 두 번째 메시지에서 OpenCode 서버 시작 실패

**증상:**
```
OpenCode error: Server exited with code 1
Failed to start server on port 4096
```

첫 메시지는 정상 응답, 두 번째 메시지부터 에러.

**원인:**
매 턴마다 `createOpencode()`를 호출하여 새 서버를 시작하려 함. 첫 번째 서버가 아직 포트 4096을 점유하고 있어 두 번째 서버 시작 실패.

**해결:**
provider에 싱글톤 패턴 적용:
```typescript
let cachedClient: unknown = null;

async function getOrCreateClient(model, log) {
  if (cachedClient) {
    log('Reusing existing OpenCode server');
    return cachedClient;
  }
  const { createOpencode } = await import('@opencode-ai/sdk');
  const { client } = await createOpencode({ config: { model }, timeout: 30000 });
  cachedClient = client;
  return client;
}
```
서버를 한 번만 시작하고 이후 턴에서 재사용. 에러 발생 시 `cachedClient = null`로 리셋하여 다음 턴에서 새 서버 시작.

**핵심 교훈:**
- OpenCode SDK의 `createOpencode()`는 로컬 서버를 시작함
- 포트 충돌 방지를 위해 서버 인스턴스를 재사용해야 함
- 에러 시에만 리셋하여 복구 가능하게 설계

---

### 최종 아키텍처

```
Discord → NanoClaw Host (Node.js)
  → SQLite 메시지 저장
  → Docker Container 스팬
    → agent-runner (TypeScript)
      → OpenCode SDK (createOpencode)
        → OpenCode Server (port 4096)
          → OpenCode Go API (kimi-k2.5)
            → 응답
      → IPC로 호스트에 결과 전달
  → Discord 채널에 응답 전송
```

### 주요 파일

| 파일 | 역할 |
|------|------|
| `container/agent-runner/src/providers/opencode.ts` | OpenCode SDK provider (싱글톤) |
| `container/agent-runner/src/providers/claude.ts` | Claude Agent SDK provider |
| `container/agent-runner/src/providers/index.ts` | Provider 팩토리 |
| `container/agent-runner/src/types.ts` | 공통 타입 |
| `src/agent-backend.ts` | 호스트 측 백엔드 설정 |
| `src/container-runner.ts` | 컨테이너 env 전달 |
| `.env` | `AGENT_BACKEND=opencode` 설정 |

### 환경변수

```
AGENT_BACKEND=opencode
OPENCODE_API_KEY=sk-...
OPENCODE_MODEL=opencode-go/kimi-k2.5
```
