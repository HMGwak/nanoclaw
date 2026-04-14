# Schedule Sync — Obsidian ↔ M365

## 개요
Obsidian vault 문서를 매시간 스캔하여 Microsoft Todo + Outlook Calendar와 동기화하는 기능.

- 스캔 대상: `1. Project/`, `2. Area of responsibility/`
- 동기화: Microsoft Todo (체크리스트), Outlook Calendar (마감일 이벤트)
- 역전파: M365 완료 → hub → 원본 문서 `[x]` 반영

## 구현 파일
```
src/catalog/tasks/schedule_sync/
  __init__.py
  msgraph_auth.py    — MSAL Device Code Flow 인증
  poc_test.py        — M365 API 연결 테스트
  vault_scanner.py   — Obsidian vault 스캔 + _sync_hub.md 생성
```

## 인증 정보
- 앱: ONE_D (Azure App Registration)
- Client ID: `db105956-62b6-4bb2-a531-c436a26e9f70`
- Tenant ID: `f3886a6c-0c14-4f69-a899-94f44f93c3a3`
- 테넌트: `globalktng.onmicrosoft.com`
- 토큰 캐시: `~/.config/nanoclaw/msgraph-token.json`
- 설정 파일: `~/.config/nanoclaw/msgraph-config.json`

## 현재 상태 (2026-04-10)

### 완료
- [x] MSAL Device Code Flow 인증 구현
- [x] `User.Read` 인증 정상 동작 확인 (`효민 곽`)
- [x] `Files.ReadWrite` 동의 완료 (기존 OneDrive 연동)
- [x] vault 스캔 정상 동작 (16개 문서 감지)
- [x] hub 파일 생성 로직 구현

### 블로킹
- [ ] `Tasks.ReadWrite` — 관리자 동의 필요
- [ ] `Calendars.ReadWrite` — 관리자 동의 필요

### 미구현
- [ ] `todo_sync.py` — Microsoft Todo API 동기화
- [ ] `calendar_sync.py` — Outlook Calendar API 동기화
- [ ] `reverse_sync.py` — M365 완료 → 원본 문서 역전파
- [ ] `sync_tracker.db` — block ID ↔ M365 ID 매핑 SQLite
- [ ] `task-scheduler.ts` — `execution_mode: 'host_script'` 분기

## 권한 해결 방법
Azure Portal → App registrations → ONE_D → API permissions에서
**Global Admin 계정으로 "Grant admin consent for globalktng" 클릭** 필요.

## 참고
- 스펙: `.omc/specs/deep-interview-schedule-sync.md`
- 플랜: `.omc/plans/secretary-schedule-sync.md`
