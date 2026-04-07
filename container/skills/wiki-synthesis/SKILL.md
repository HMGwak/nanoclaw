---
name: wiki-synthesis
description: Wiki 합성 및 업데이트. Obsidian vault의 raw 문서를 카파시루프(quality-loop)로 합성하여 구조화된 wiki note를 생성/업데이트한다.
---

# Wiki Synthesis Skill

Obsidian vault의 raw 업무 문서를 분석하여 도메인별 wiki note를 자동 생성하거나 업데이트한다.
내부적으로 카파시루프(quality-loop) 엔진을 사용하여 rubric 기반 반복 개선을 수행한다.

## Commands

### /start_wiki_synthesis — 신규 생성 (1회차)

해당 도메인의 wiki를 처음부터 새로 생성한다. 기존 DB 기록이 있으면 리셋 후 재생성.

**필수 인자:**
- `domain`: 도메인명 (아래 지원 도메인 참조)
- `wiki_output_dir`: 완성된 wiki가 저장될 폴더 경로 (Obsidian vault wiki 폴더)

**선택 인자:**
- `model`: LLM 모델 (기본: gpt-5.4). 로컬: gemma4-26b, gemma4-e4b
- `max_docs`: 처리할 최대 문서 수 (테스트용)

### /update_wiki_synthesis — 증분 업데이트 (2회차+)

기존 wiki에 new/changed 문서만 merge하여 업데이트한다. DB에서 이전 wiki를 자동 로드.

**필수 인자:**
- `domain`: 도메인명
- `wiki_output_dir`: wiki 저장 경로

**선택 인자:**
- `model`: LLM 모델
- `max_docs`: 처리할 최대 문서 수

## Supported Domains

| 도메인 | rubric | base index | filter |
|--------|--------|------------|--------|
| 안전성검토 | `src/catalog/tasks/wiki/rubrics/rubric_안전성검토.md` | `3. Resource/LLM Knowledge Base/index/안전성검토.base` | `(안전성검토)_*.md` |
| 첨가물정보제출 | `src/catalog/tasks/wiki/rubrics/rubric_첨가물정보제출.md` | `3. Resource/LLM Knowledge Base/index/첨가물정보 제출.base` | `(규제준수)_*.md` |

새 도메인을 추가하려면: rubric 파일 생성 + 이 테이블에 행 추가.

## How to Trigger

사용자가 wiki 관련 요청을 하면 이 skill을 사용한다.

**신규 생성 트리거 패턴:**
- "XXX wiki 만들어줘"
- "XXX wiki 작성해줘"
- "XXX wiki 새로 생성"

**업데이트 트리거 패턴:**
- "XXX wiki 업데이트해줘"
- "XXX wiki 갱신해줘"
- "XXX 새 문서 반영해줘"

## Implementation

`start_workflow` MCP tool을 호출하여 카파시루프 워크플로우를 시작한다.

### start_wiki_synthesis 실행 방법

1. 도메인 → config 매핑 (위 테이블 참조)
2. `start_workflow` MCP tool 호출:

```json
{
  "title": "Wiki Synthesis: {domain}",
  "steps": [
    {
      "assignee": "discord_secretary_bot",
      "goal": "{domain} 도메인의 wiki note를 raw 문서에서 신규 합성",
      "acceptance_criteria": [
        "{\"task\":\"wiki_task.WikiTask\",\"rubric\":\"src/catalog/tasks/wiki/rubrics/rubric_{domain}.md\",\"domain\":\"{domain}\",\"vault_root\":\"/Users/planee/Documents/Mywork\",\"base_path\":\"3. Resource/LLM Knowledge Base/index/{base_file}\",\"filter\":\"{filter}\",\"wiki_output_dir\":\"{wiki_output_dir}\"}"
      ],
      "constraints": ["Archive 폴더 문서만 대상", "hallucination 금지"],
      "stage_id": "execute"
    }
  ]
}
```

### update_wiki_synthesis 실행 방법

동일한 `start_workflow` 호출. DB에 해당 domain 기록이 있으면 자동으로:
- 이전 wiki를 DB output_path에서 로드
- new/changed 문서만 추출 (SHA256 해시 비교)
- 기존 wiki에 MdDiff merge

### 주의사항

- `acceptance_criteria`는 **반드시 string array** 형식이어야 한다. JSON 객체를 문자열로 감싸서 배열에 넣을 것.
- `vault_root`는 **호스트 경로** 사용 (컨테이너 경로 `/workspace/...` 아님).
- 평가(reviewer)는 항상 gpt-5.4 사용. `model` 인자는 wiki 생성 에이전트에만 적용.
- 첨가물정보제출의 base 파일명에 공백이 있음: `첨가물정보 제출.base`
- PMI/PMIzhora는 국가가 아닌 파트너 조직으로 별도 분류됨.

## Architecture

```
사용자 메시지 → 비서봇 → skill 감지
  → start_workflow MCP tool (IPC)
  → 호스트 workflow engine
  → hasQualityLoopConfig → executeQualityLoopStep
  → python engine.py (subprocess)
  → WikiTask.run/revise → ChunkedSynthesizer
  → rubric 평가 → keep/revise/discard 판정
  → keep/converged → DB 기록 + wiki_output_dir에 자동 복사
  → 비서봇에 결과 보고
```

## Troubleshooting

| 증상 | 원인 | 해결 |
|------|------|------|
| "wiki_output_dir is required" 에러 | config에 wiki_output_dir 누락 | acceptance_criteria JSON에 추가 |
| 이전 wiki가 로드 안 됨 | DB에 해당 domain 기록 없음 | start_wiki_synthesis로 먼저 1회차 실행 |
| MdDiff 파싱 실패 | LLM이 JSON 형식 미준수 | 로그 확인, fallback으로 원본 유지됨 |
| 점수가 안 오름 | rubric 기준 미달 | rubric 항목 조정 또는 프롬프트 개선 |
| Archive 밖 문서 포함 | base_index 필터 문제 | .base 파일의 top-level filters 확인 |
