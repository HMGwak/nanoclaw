---
name: wiki-synthesis
description: Wiki 합성 및 업데이트. Obsidian vault의 raw 문서를 카파시루프(quality-loop)로 합성하여 구조화된 wiki note를 생성/업데이트한다.
---

# Wiki Synthesis Skill

Obsidian vault의 raw 업무 문서를 분석하여 도메인별 wiki note를 자동 생성하거나 업데이트한다.
내부적으로 카파시루프(quality-loop) 엔진을 사용하여 rubric 기반 반복 개선을 수행한다.

## How to Trigger

사용자가 wiki 관련 요청을 하면 이 skill을 사용한다.

**신규 생성:** "XXX wiki 만들어줘", "XXX wiki 작성해줘", "XXX wiki 새로 생성"
**업데이트:** "XXX wiki 업데이트해줘", "XXX wiki 갱신해줘", "XXX 새 문서 반영해줘"

## 실행 절차

### 1단계: 필요한 정보 수집

`start_workflow`를 호출하기 전에 아래 파라미터를 모두 확인해야 한다.
**모르는 것은 직접 탐색하거나, 탐색으로도 알 수 없으면 사용자에게 물어봐라.**

#### domain (도메인명)
사용자 요청에서 추출. 예: "안전성검토", "첨가물정보제출"
- 불명확하면 사용자에게 물어봐라: "어떤 도메인의 wiki를 만들까요?"

#### rubric 파일 경로
`safe_shell`로 직접 탐색:
```
find /workspace/src/catalog/tasks/wiki/rubrics -name "*.md"
```
도메인명과 일치하는 파일을 선택. 없으면 사용자에게 알려줘.

#### base 인덱스 파일 경로
`safe_shell`로 직접 탐색:
```
find /workspace/vault -name "*.base"
```
도메인명과 관련된 파일을 선택. 없으면 사용자에게 물어봐라.

#### filter 패턴
rubric 파일에서 확인하거나, base 파일명에서 유추.
모르면 사용자에게 물어봐라: "어떤 파일 패턴을 대상으로 할까요? (예: `(안전성검토)_*.md`)"

#### wiki_output_dir (저장 경로)
사용자 요청에 경로가 있으면 사용. 없으면 사용자에게 물어봐라.
저장 경로는 `/Users/planee/Documents/Mywork` 하위 폴더일 가능성이 높다.
예: `/Users/planee/Documents/Mywork/3. Resource/LLM Knowledge Base/wiki/안전성검토`

#### vault_root
항상 `/Users/planee/Documents/Mywork` (호스트 절대경로 — 변경하지 말 것)

### 2단계: start_workflow 호출

모든 파라미터가 확인되면 `start_workflow` 호출.

**⚠️ acceptance_criteria 형식 엄수:**
- 반드시 **JSON 객체를 문자열로 직렬화한 값을 배열에 넣어야** 한다
- 자연어 텍스트("노트 존재 여부 확인" 같은 것) 절대 금지
- `task`와 `rubric` 필드가 없으면 서버에서 즉시 거부됨

```json
{
  "title": "Wiki Synthesis: {domain}",
  "steps": [
    {
      "assignee": "discord_secretary_bot",
      "goal": "{domain} 도메인의 wiki note를 raw 문서에서 합성",
      "acceptance_criteria": [
        "{\"task\":\"wiki_task.WikiTask\",\"rubric\":\"{rubric_path}\",\"domain\":\"{domain}\",\"vault_root\":\"/Users/planee/Documents/Mywork\",\"base\":\"{base_path}\",\"filter\":\"{filter}\",\"wiki_output_dir\":\"{wiki_output_dir}\"}"
      ],
      "constraints": ["Archive 폴더 문서만 대상", "hallucination 금지"],
      "stage_id": "execute"
    }
  ]
}
```

acceptance_criteria 배열 안의 값은 **JSON 객체를 문자열로 escape한 것**이어야 한다. 일반 텍스트 항목을 넣으면 서버에서 오류가 반환되며 워크플로우가 시작되지 않는다.

### 3단계: 즉시 종료

`start_workflow` 호출 후 사용자에게 "워크플로우가 시작됐습니다" 메시지만 보내고 종료.
추가로 파일을 읽거나 작업하지 말 것.

## 주의사항

- `assignee`는 반드시 `"discord_secretary_bot"` — 다른 값 절대 사용 금지
- `acceptance_criteria`는 반드시 **string array** 형식 (JSON 객체를 문자열로 감싸서 배열에 넣을 것)
- `vault_root`는 **호스트 경로** 사용 (컨테이너 경로 `/workspace/vault` 아님)
- `base` 필드명 사용 (`base_path` 아님)
- 업데이트(2회차+): DB에 이전 wiki 기록이 있으면 자동으로 증분 처리됨

## Architecture

```
사용자 메시지 → 비서봇 → skill 감지
  → 파라미터 탐색/수집 (safe_shell + 사용자 질문)
  → start_workflow MCP tool (IPC)
  → 호스트 workflow engine → python engine.py
  → WikiTask → rubric 평가 → 반복 개선
  → wiki_output_dir에 자동 복사 → 비서봇에 결과 보고
```
