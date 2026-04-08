---
name: wiki-synthesis
description: Wiki 합성 및 업데이트. Obsidian vault의 raw 문서를 카파시루프(quality-loop)로 합성하여 구조화된 wiki note를 생성/업데이트한다.
---

# Wiki Synthesis Skill

Obsidian vault의 raw 업무 문서를 분석하여 도메인별 wiki note를 자동 생성하거나 업데이트한다.

## How to Trigger

사용자가 wiki 관련 요청을 하면 이 스킬을 사용한다.

- "XXX wiki 만들어줘 / 작성해줘 / 생성해줘"
- "XXX wiki 업데이트해줘 / 갱신해줘"

## 실행 절차

### 1단계: 파라미터 수집

`wiki_synthesis` 도구를 호출하기 전에 아래 파라미터를 확인한다.
**직접 탐색할 수 있는 것은 탐색하고, 알 수 없는 것은 사용자에게 물어봐라.**

#### domain
사용자 요청에서 추출. 불명확하면 물어봐라.

#### rubric_file
`safe_shell`로 탐색:
```
find /workspace/project/src/catalog/tasks/wiki/rubrics -name "*.md"
```
도메인명과 일치하는 파일 선택.

#### base_file
`safe_shell`로 탐색:
```
find /workspace/extra/vault -name "*.base"
```
도메인명과 관련된 파일 선택.

#### filter (선택)
rubric 파일 내용을 `cat`으로 읽어 필터 패턴 확인. 없으면 사용자에게 물어봐라.

#### wiki_output_dir
완성된 wiki가 저장될 Obsidian 폴더 경로. `/Users/planee/Documents/Mywork` 하위일 가능성이 높다.
사용자 요청에 없으면 물어봐라.

### 2단계: wiki_synthesis 도구 호출

```
wiki_synthesis(
  domain="...",
  rubric_file="/workspace/src/catalog/tasks/wiki/rubrics/rubric_{domain}.md",
  base_file="/workspace/vault/3. Resource/LLM Knowledge Base/index/{domain}.base",
  wiki_output_dir="/Users/planee/Documents/Mywork/...",
  filter="..."   # 선택
)
```

### 3단계: 즉시 종료

도구 호출 후 "워크플로우가 시작됐습니다" 메시지만 보내고 종료.

## 주의사항

- vault 파일을 직접 수정하거나 삭제하지 말 것
- `wiki_synthesis` 도구가 내부적으로 올바른 포맷으로 변환하므로, JSON 형식을 직접 구성하지 않아도 됨
- vault_root는 도구 기본값(`/Users/planee/Documents/Mywork`)을 그대로 사용
