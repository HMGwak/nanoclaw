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

#### specs (확인용)
`safe_shell`로 도메인 사양(spec)이 존재하는지 확인:
```
ls /workspace/project/src/catalog/tasks/wiki/specs/{domain}.json
```
파일이 없으면 사용자에게 해당 도메인에 대한 wiki 생성 권한이나 설정이 있는지 확인한다.

#### wiki_output_dir
완성된 wiki가 저장될 Obsidian 폴더 경로. `/Users/planee/Documents/Mywork` 하위일 가능성이 높다.
사용자 요청에 없으면 물어봐라.

### 2단계: wiki_synthesis 도구 호출

기본적으로 `domain`과 `wiki_output_dir`만 넘기면, 도구가 `base_file`과 `spec`을 자동 탐색한다.

```
wiki_synthesis(
  domain="...",
  wiki_output_dir="/Users/planee/Documents/Mywork/3. Resource/LLM Knowledge Base/wiki",
  filter="..."   # 선택 (특정 국가/지역 필터링이 필요한 경우)
)
```

### 3단계: 즉시 종료

도구 호출 후 "워크플로우가 시작됐습니다" 메시지만 보내고 종료.

## 주의사항

- vault 파일을 직접 수정하거나 삭제하지 말 것
- `wiki_synthesis` 도구가 내부적으로 올바른 포맷으로 변환하므로, JSON 형식을 직접 구성하지 않아도 됨
- vault_root는 도구 기본값(`/Users/planee/Documents/Mywork`)을 그대로 사용
