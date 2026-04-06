# NanoClaw

## 금지 사항 (절대 위반 금지)

- **Claude SDK / Anthropic SDK 사용 금지** — 이 프로젝트에서 anthropic 패키지를 import하거나 사용하지 않는다.
- **ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN 사용 금지** — 이 토큰들을 코드에서 읽거나 주입하지 않는다.
- **Claude를 에이전트로 제안 금지** — 카탈로그 에이전트로 Claude/Anthropic 모델을 제안하지 않는다.
- 이 프로젝트의 에이전트 백엔드는 openai, opencode, zai, openai-compat만 사용한다.

## 인증 방법

### 핵심 원칙
- **OPENAI_API_KEY 불필요** — 이 프로젝트는 ChatGPT OAuth로 인증한다. API 키를 요구하거나 제안하지 말 것.
- **openai SDK 사용** — 모든 LLM 호출은 openai SDK (`openai.OpenAI(...)`)를 통해 이루어진다. requests, httpx 등으로 직접 HTTP 호출하지 말 것.
- **모델 변경 금지** — 기본 모델은 gpt-5.4이다. 다른 모델(gpt-4o, gpt-4 등)을 제안하지 말 것. 로컬 모델(gemma4, qwen3.5)은 명시적으로 지정할 때만 사용.

### ChatGPT OAuth (기본, openai SDK 기반)
- `~/.codex/auth.json`의 OAuth 토큰을 openai SDK에 주입
- `openai.OpenAI(api_key=access_token, base_url="https://chatgpt.com/backend-api/codex", default_headers={"ChatGPT-Account-ID": account_id})`
- `client.responses.create(stream=True, store=False)` — 스트리밍 필수
- 토큰 갱신: `POST https://auth.openai.com/oauth/token` (refresh_token)
- client_id: `app_EMoamEEZ73f0CkXaXp7hrann`
- 구현 위치: `src/catalog/sdk_profiles/chatgpt_oauth.py`

### 환경변수 백엔드 (대안, 컨테이너 전용)
- `NANOCLAW_AGENT_BACKEND` 환경변수로 선택
- zai: `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL`
- opencode: CLI 전용 (직접 API 호출 불가)

