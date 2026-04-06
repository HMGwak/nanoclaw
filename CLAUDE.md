# NanoClaw

## 금지 사항 (절대 위반 금지)

- **Claude SDK / Anthropic SDK 사용 금지** — 이 프로젝트에서 anthropic 패키지를 import하거나 사용하지 않는다.
- **ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN 사용 금지** — 이 토큰들을 코드에서 읽거나 주입하지 않는다.
- **Claude를 에이전트로 제안 금지** — 카탈로그 에이전트로 Claude/Anthropic 모델을 제안하지 않는다.
- 이 프로젝트의 에이전트 백엔드는 openai, opencode, zai, openai-compat만 사용한다.

## 인증 방법

### ChatGPT OAuth (기본)
- `~/.codex/auth.json`에 저장된 OAuth 토큰 사용
- 엔드포인트: `https://chatgpt.com/backend-api/codex/responses`
- 헤더: `Authorization: Bearer {access_token}`, `ChatGPT-Account-ID: {account_id}`
- 필수 파라미터: `stream: true`, `store: false`
- 토큰 갱신: `POST https://auth.openai.com/oauth/token` (refresh_token)
- client_id: `app_EMoamEEZ73f0CkXaXp7hrann`
- 지원 모델: gpt-5.4 (ChatGPT Pro 계정 전용 모델)

### 환경변수 백엔드 (대안)
- `NANOCLAW_AGENT_BACKEND` 환경변수로 선택
- openai: `OPENAI_API_KEY` + `OPENAI_BASE_URL`
- zai: `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL`
- opencode: CLI 전용 (직접 API 호출 불가)

