"""ChunkedSynthesizer - Map-Reduce wiki synthesis engine.

Map phase : Codex SDK 에이전트가 전체 문서를 병렬 탐색하여 구조화된 claim JSON 반환.
            (2026-04-08 대체: 기존 배치별 agent.generate() → Codex SDK 1회 호출)
Reduce phase: merge all extractions into a single wiki note (Markdown).

=== Legacy MAP (2026-04-08 이전) ===
- 문서를 batch_size 단위로 분할 → 배치마다 agent.generate() 호출
- 배치 내 패턴만 추출 (배치 간 교차 패턴 미포착)
- 원문 quote 미보존 (패턴 요약만)
- 레거시 코드: legacy/map_legacy.py 참조

=== Codex MAP (현재) ===
- Codex SDK에 전체 문서 경로 전달 → 서브에이전트가 병렬 탐색
- 문서 간 교차 패턴 포착, 원문 quote 100% 보존
- 1회 호출로 전체 처리 (claim JSON + patterns)
- claim → extraction 변환 후 기존 REDUCE와 호환

Supports:
- create  : build a new wiki note from scratch
- update  : merge new extractions into an existing wiki note
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
from pathlib import Path

from pydantic import BaseModel

try:
    from .json_utils import try_parse_validated, parse_validated_list
    from .markdown_utils import (
        MarkdownSectionEditor,
        SectionEdit,
        strip_code_blocks,
        filter_attachment_footnotes,
        merge_missing_footnote_definitions,
        dedup_footnotes_by_source,
        canonicalize_regulation_markdown,
        preserve_canonical_subtrees,
        md_to_json,
        json_to_md,
        apply_json_diffs,
        MdNode,
        MdDiff,
    )
except ImportError:
    from json_utils import try_parse_validated, parse_validated_list  # type: ignore[no-redef]
    from markdown_utils import (  # type: ignore[no-redef]
        MarkdownSectionEditor,
        SectionEdit,
        strip_code_blocks,
        filter_attachment_footnotes,
        merge_missing_footnote_definitions,
        dedup_footnotes_by_source,
        canonicalize_regulation_markdown,
        preserve_canonical_subtrees,
        md_to_json,
        json_to_md,
        apply_json_diffs,
        MdNode,
        MdDiff,
    )


# MapExtraction은 legacy/map_legacy.py로 이동 (2026-04-08)

logger = logging.getLogger(__name__)

_META_CLAIM_TOKENS = (
    "작업 완료 상태",
    "결과 파일 위치",
    "_final_claims",
    "_codex_doc_list",
    "_codex_map_log",
    ".codex_tmp",
    "로그 생성",
    "체크 완료",
    "산출물 검증",
)

_CANONICAL_SECTION_TOKENS = (
    "규제 환경 요약",
    "첨가물정보제출",
    "분석결과제출",
    "제품 규격 및 준수사항",
)

PROMPT_SURFACE_VERSION = "v2"


def _sanitize_section_target(section_target: str) -> str:
    if not section_target:
        return ""
    cleaned = section_target.strip()
    for token in _CANONICAL_SECTION_TOKENS:
        idx = cleaned.find(token)
        if idx >= 0:
            return cleaned[idx:].lstrip("# ").strip()
    return cleaned


# ── Codex MAP 설정 ───────────────────────────────────────────────
# 2026-04-08: 배치별 agent.generate() 방식에서 Codex SDK 1회 호출로 대체.
# 레거시 MAP 코드: legacy/map_legacy.py 참조.

try:
    from catalog.sdk_profiles.codex_oauth import run_codex_prompt
except ImportError:
    try:
        import sys as _sys

        _sys.path.insert(0, str(Path(__file__).parent.parent.parent))
        from catalog.sdk_profiles.codex_oauth import run_codex_prompt  # type: ignore[no-redef]
    except ImportError:
        run_codex_prompt = None  # type: ignore[assignment]

CODEX_MAP_CLAIM_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "claim": {
                        "type": "string",
                        "description": "주제 제목 또는 섹션 헤더",
                    },
                    "detail": {
                        "type": "string",
                        "description": "상세 서술 (법적 근거, 조건, 예외 등 모두 포함)",
                    },
                    "items": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "목록형 요소 (예: 금지 첨가물 목록, 필수 서류 목록). 없으면 빈 배열.",
                    },
                    "item_legal_basis": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "각 items 항목별 법적 근거. items[i]에 해당하는 법률명+조항. items와 같은 길이.",
                    },
                    "legal_basis": {
                        "type": "string",
                        "description": "주제 전체의 법률명과 조항 번호 (예: '법률명 §조항'). 없으면 빈 문자열.",
                    },
                    "quote": {
                        "type": "string",
                        "description": "원문 인용 (최대 500자)",
                    },
                    "doc_id": {"type": "string"},
                    "section_target": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": [
                    "claim",
                    "detail",
                    "items",
                    "item_legal_basis",
                    "legal_basis",
                    "quote",
                    "doc_id",
                    "section_target",
                    "confidence",
                ],
            },
        },
    },
    "required": ["claims"],
}

CODEX_MAP_PROMPT_TEMPLATE = """\
당신은 규제 문서 분석 **최상위 오케스트레이터**입니다. 아래 {doc_count}개 문서에서 wiki 작성에 필요한 **RAG 수준의 상세 내용**을 추출합니다.

문서 경로 목록:
{doc_listing}

## ⚠️ 절대 규칙: 파일 접근 제한

- **오직 위 목록 파일에 나열된 문서만 읽을 수 있습니다.**
- `ls`, `find`, `grep`, `cat` 등으로 **목록에 없는 파일을 찾거나 읽지 마세요.**
- 다른 국가 문서, 다른 주제 문서, 관련 자료를 "보강"하기 위해 vault를 탐색하지 마세요.
- 목록에 나열된 `{doc_count}`개 문서 이외에서 나온 내용은 **즉시 폐기**해야 합니다.
- 모든 claim의 `doc_id`는 **반드시** 위 목록에 있는 파일 경로와 정확히 일치해야 합니다.
- 목록 외 파일에서 나온 claim을 반환하면 전체 출력이 실패로 간주됩니다.

**이 제한의 이유**: wiki 생성 파이프라인은 country/filter 기준으로 사전에 문서를 선별합니다. 사용자가 지정한 국가와 무관한 문서를 읽으면 잘못된 국가의 정보가 섞여 결과를 오염시킵니다.

# 계층적 오케스트레이션 전략

## Level 1: 최상위 오케스트레이터 (당신)
- 문서 목록을 파악하고 각 문서를 **Level 2 서브 오케스트레이터**로 위임
- 문서 간 중복 주제는 마지막 병합 단계에서 해결
- 각 문서가 완료되면 로그 파일 업데이트

## Level 2: 문서별 서브 오케스트레이터 (각 문서당 1회)
각 문서에 대해 아래 절차를 밟으세요:

### Step 2a: 문서 전체 읽기 + 목차 파악
1. `cat`으로 문서 전체를 읽으세요
2. 목록 파일에서 `- [ ]`를 `- [x]`로 변경 (sed)
3. Markdown 헤더(#, ##, ###) 구조를 파악하여 **섹션 맵**을 만드세요
4. 각 섹션이 9개 주제 체크리스트 중 어디에 해당하는지 매핑

### Step 2b: 섹션별 청킹 및 Level 3 위임
섹션이 많거나 문서가 길면 **섹션 단위로 독립 처리**하세요:
- 각 섹션(또는 논리 블록)마다 claim 추출을 **별도 패스**로 수행
- 한 섹션에서 여러 주제가 나오면 여러 claim 생성
- 절대 한 섹션을 다른 섹션 내용과 한 claim에 섞지 마세요

### Step 2c: 섹션별 심층 추출 (Level 3)
각 섹션에 대해:
- 법률 원문을 조항 단위로 읽고 **모든 수치, 임계값, 기한, 목록 항목을 빠짐없이 추출**
- 목록(list, enumeration)이 있으면 **전체 항목을 개별 items 배열로 보존** (축약 금지)
- 법적 근거(§ 조항, Anlage, Annex)를 claim의 legal_basis에 정확히 기록
- "당국은 ~할 수 있다" "관할 기관이 요구할 경우" 같은 **재량 조항은 '실무 운영 패턴' 힌트**로 별도 extracted_practice 항목에 기록

## Level 1: 최종 병합
모든 Level 2 결과를 수집하여:
- 동일 주제의 claim은 items/legal_basis 합집합으로 병합 (전체 목록 보존)

Atomic Claim 추출 원칙 (핵심):
- 각 법적 요건은 원자적으로 추출하여 개별 법적 근거와 연결
- 복합 조항 분해: 하나의 조항에 여러 요건이 있으면 각각 별도 item으로 분리
- item_legal_basis: 각 items[i]에 해당하는 정확한 법적 근거를 동일 인덱스에 기록
- items와 item_legal_basis는 반드시 같은 길이여야 함
- 정확한 조항 번호 사용: 범위 표현보다 각 item의 정확한 소조항 명시
- REDUCE 단계에서 각 item이 inline citation 형태로 렌더링되도록 정확한 근거 기록

---

# 9개 주제 체크리스트 (모든 문서에서 탐색)

**각 주제마다 문서에 존재하면 claim 생성, 없으면 status="absent" (name만 기록, claim 생성 안 함)**

1. **정보 제출 시기** — 신규/변경/정기 제출 기한, 기산일, 연간 주기, 사전 통지 리드타임
2. **제출해야 하는 정보** — 성분, 배출값, 제품 식별정보, 포장 이미지, 시험자료, 독성자료, 판매량, 제출처 기관/포털 URL/파일 포맷(XML/PDF 등)
3. **제품 규격 positive/negative list** — 허용 첨가물 목록(positive) / 금지 첨가물 목록(negative). 전체 항목 items 배열로 보존.
4. **유해물질 규제** — 특정 화학물질, CMR, 알레르겐, 비타민·카페인 등 건강 효과 암시 물질 규제
5. **기타 재료품 규격** — 필터, 궐련지, 접착제, 팁페이퍼, 캡슐 등 담배 구성품 기준
6. **TNCO 및 연기성분 규제** — T/N/CO 상한, 측정법, 기타 연기성분(알데하이드, HCN, NNK 등)
7. **가향 규제** — 특징향 금지, 향료 첨가 제한, 멘톨 금지
8. **제품 물리 규격** — 길이, 둘레, 무게, 필터 길이, 포장 단위, 최소 판매 단위
9. **그 외** — 라벨/경고문구, 광고금지, 라이선스, 추적관리, 벌칙, 통과/진입 요건

---

# claim 추출 핵심 원칙

1. **1 claim = 1 주제 + 모든 상세**: 원자적 사실이 아니라 주제별 전체 상세 블록
2. **RAG 수준**: wiki 독자가 원문 없이도 완전히 이해 가능
3. **원문 내용만**: 다른 국가의 관행이나 일반 상식을 섞지 말 것
4. **Items 전체 보존**: 원문에 10개 항목이 있으면 items에 10개 모두 나열. 일부만 예시로 들지 말 것.
5. **수치/기한 원형 보존**: "**10 mg/개비**", "**30일 이내**", "**매년 12월 31일**" 등을 원문 그대로 detail에 기록 (wiki에서 강조 렌더링됨)
6. **재량 조항 → 실무 힌트**: "당국이 ~를 요구할 수 있다", "관할 기관 판단에 따라" 등 재량 표현이 있으면 detail 끝에 `[실무 패턴: ...]`로 별도 명시
7. **최종 응답은 규제 claims만**: 작업 상태, 파일 경로, 로그 생성 여부, 체크리스트 진행률, 결과 저장 위치, 검증 완료 메시지를 claim으로 만들지 말 것
8. **임시 파일/내부 산출물 금지**: `.codex_tmp`, `_final_claims`, `_codex_doc_list`, `_codex_map_log`, `작업 완료 상태`, `결과 파일 위치` 같은 내부 메타데이터를 claims/doc_id/quote/detail에 넣지 말 것
9. **최종 응답 본문이 진짜 산출물**: 파일에 따로 저장했다고 설명하지 말고, 최종 assistant 응답 자체를 schema에 맞는 최종 JSON으로 반환할 것

## 각 claim 필드 (구조만, 내용은 실제 문서에서)

- **claim**: 주제 제목 (예: 한 문서에서 다루는 조항/주제 1개)
- **detail**: 상세 서술. 문서에 존재하는 요소만 포함:
  - 법적 근거: 법률명 + 조항 번호
  - 적용 대상: 제품군 / 사업자 / 상황
  - 조건과 수치: 임계값 / 기한 / 주기 / 예외
  - 위반 시 결과: 벌칙 / 행정처분
  - 실무 패턴 힌트: 재량 조항에서 유추된 운영 힌트 (있으면)
- **items**: 문서에 목록 형태로 존재하는 경우 **전체 항목** 배열. 없으면 `[]`.
- **item_legal_basis**: 각 items[i]에 해당하는 법적 근거 배열. items와 같은 길이. 각 item이 어떤 법 조항에서 유래했는지 정확히 기록.
- **legal_basis**: 주제 전체의 법률 약어 + 조항 번호 형식. 문서에 명시된 것만.
- **quote**: 원문 핵심 구문 1-3문장 (원문 언어 그대로, 최대 500자)
- **doc_id**: 파일명 (여러 문서 해당 시 세미콜론 연결)
- **section_target**: wiki 섹션 — 아래 중 선택:
  - `## 규제 환경 요약`
  - `## 첨가물정보제출 > ### 규제 요건` / `### 신규제출` / `### 변경제출` / `### 정기제출`
  - `## 분석결과제출 > ### 규제 요건` / `### 신규제출` / `### 변경제출` / `### 정기제출`
  - `## 제품 규격 및 준수사항 > ### 담배 원료 (tobacco)` / `### 담배 외 원료 및 재료 (other than tobacco)` / `### 담배 제품 (tobacco products)`
- **confidence**: high / medium / low

## 나쁜 claim (하지 마세요)

- "해당 국가는 일부 첨가물 사용을 금지한다" — 추상적, 구체 항목·조항 없음
- "대부분의 국가는 경고문구를 요구한다" — 일반화
- 문서에 없는 국가명/수치/법률명을 추측
- items에 "..." 또는 "기타 등등"으로 목록을 축약
- 여러 섹션 내용을 한 claim에 뭉쳐서 법적 근거가 모호해지는 것
- "작업 완료 상태", "결과 파일 위치", "로그 17개 생성" 같은 오케스트레이션/메타 보고
- `_final_claims_orchestrated_v2.json`, `.codex_tmp/...` 같은 임시 산출물 경로를 규제 claim처럼 반환하는 것

---

# 문서별 처리 로그

각 문서를 처리한 후 아래 디렉토리에 파일명과 동일한 JSON 파일을 생성하세요:
  {doc_log_dir}

형식:
- 처리 성공: {{"doc":"파일명.md","claims":추출수,"sections_processed":섹션수,"summary":"핵심 1줄 요약"}}
- 스킵: {{"doc":"파일명.md","claims":0,"reason":"스킵 사유"}}

---

# 파일 접근 불가 시

- cat으로 문서를 읽을 때 permission denied, bwrap 오류, 빈 내용이면 즉시 중단
- 읽지 못한 문서로 claim을 만들지 마세요
- 접근 불가 시 error: "FILE_ACCESS_DENIED"를 포함한 JSON 반환

**원문에 없는 내용은 절대 추가하지 마세요. 하지만 원문에 있는 내용은 모두 반영하세요.**"""


# ── Prompts (REDUCE) ─────────────────────────────────────────────

_REDUCE_SYSTEM_BASE = """\
You are an expert regulatory wiki author. Synthesize the extracted claims into a structured wiki note with RAG-level detail.

{structure_block}

## 입력 데이터 구조

입력은 JSON 형태의 extraction이며, 핵심 필드는 다음과 같습니다:

- **상세주제** (detailed_topics): 문서에서 추출된 주제별 상세 블록 배열. 각 항목:
  - `주제`: 섹션 헤더
  - `상세`: 법적 근거, 조건, 수치, 예외를 모두 포함하는 상세 서술
  - `목록`: 원문의 전체 목록 (예: 금지 첨가물 50개)
  - `법적근거`: 법률명 + 조항 번호
  - `원문인용`: 원문 핵심 구문
  - `출처`: 파일명
  - `섹션`: wiki 내 배치 위치

## 작성 핵심 원칙

1. **RAG 수준 상세 보존**: `상세주제`의 `상세`와 `목록`을 **축약하지 말고 그대로 반영**하세요.
   - 50개 금지 첨가물이 있으면 50개 모두 bullet로 나열
    - 법 조항은 `법적근거` 필드를 그대로 본문에 표기 (예: "관련 법령의 해당 조항에 따라...")
   - 수치, 기한, 임계값, 예외는 빠짐없이 보존
2. **각 헤더가 충분히 풍부**해야 합니다. 독자가 원문을 보지 않고도 규제 내용 전체를 이해할 수 있어야 합니다.
3. **주제를 섹션에 매핑**: 각 `상세주제`의 `섹션` 필드를 따라 적절한 wiki 섹션 아래 배치하세요.
4. **목록은 불릿으로 전개**: `목록` 필드의 모든 항목을 하위 bullet로 나열하세요. 5개 넘어도 OK, 모두 보존.
5. **수치/기한/임계값 Bold 강조**: 모든 숫자·기한·임계값·벌칙액은 `**값**`으로 감싸라.
   - 예: `**10 mg/개비**`, `**30일 이내**`, `**매년 12월 31일**`, `**최대 50,000 EUR**`
   - 실무자가 수치만 훑어도 핵심을 파악할 수 있어야 함
6. 공통 규칙이 여러 제품군에 동일하게 적용되면 중복해서 3번 반복하지 말고 하나의 공통 bullet로 병합하라.
7. 빈 섹션은 정확히 `해당 없음 (근거 문서 없음)`으로만 표기하라.

## 형식 규칙

- Obsidian 각주: 본문 `[^1]`, 정의 `[^1]: [[(파일명)#헤더]]` (파일명에서 .md 생략)
- 모든 사실 문단/블록에 각주 출처 필수. 법적 근거가 명시된 bullet는 더 중요.
- 원문에 없는 내용 추가 금지. 그러나 원문에 있는 상세는 **모두 반영**.
- 방어적 헤징 금지 ("확인된 바에 따르면" 같은 표현).
- 한국어 작성.
- 마크다운 테이블 금지, bullet 구조 사용.
- 들여쓰기: 4칸 스페이스 (탭 금지). Level 0 `- item`, Level 1 `    - sub-item`, Level 2 `        - sub-sub-item`.

## 구조 규칙

- 구조 템플릿 (위의 `Required wiki note structure`)을 정확히 따르세요. 섹션 추가/삭제/이름변경 금지.
- 빈 섹션이 있으면 "해당 없음 (근거 문서 없음)" + 각주 표기.
- 리스트 항목 안에 heading marker(`#`)를 쓰지 마세요.
- 제품군 표시는 heading이 아니라 `- **제품군명:** 내용` 또는 `- **제품군명**` + 중첩 bullet만 허용합니다.
- `법규:`, `실무:`, `제출 범위:` 같은 비정규 pseudo-label을 만들지 마세요.
"""


_DEFAULT_STRUCTURE = [
    "## 핵심 성격",
    "## 반복 패턴",
    "### 반복 입력자료",
    "### 반복 산출물",
    "## 절차",
    "## 대표 사례 (최소 3개, 각 사례에 각주 참조)",
    "## 열린 이슈 (불확실하거나 추가 확인이 필요한 항목)",
]


def _build_structure_block(doc_structure: list[str] | None = None) -> str:
    """Build the wiki structure instruction block (shared by reduce and incremental prompts).

    doc_structure comes from the spec structure entry.
    If None/empty, falls back to _DEFAULT_STRUCTURE for backward compatibility
    with wiki types that don't use a rubric (e.g., generic doc → wiki synthesis).
    Layer 1 (tobacco country wiki) MUST always pass doc_structure — absence indicates
    a configuration bug in the caller, not a valid synthesis path.
    """
    if not doc_structure:
        # Backward compatibility for wiki types without spec-provided structure.
        # Layer 1 callers (run_wiki.py layer1 behavior) should always pass doc_structure.
        import warnings

        warnings.warn(
            "doc_structure is None/empty — falling back to _DEFAULT_STRUCTURE. "
            "For country layer1 wiki, doc_structure must come from the spec structure entry.",
            UserWarning,
            stacklevel=3,
        )
        headings = _DEFAULT_STRUCTURE
    else:
        headings = doc_structure
    lines = [
        "IMPORTANT: You MUST use EXACTLY the following heading structure. Do NOT add, rename, or reorder sections.",
        "",
        "Required wiki note structure:",
        "1. YAML frontmatter (tags, created, domain)",
    ]
    for i, h in enumerate(headings, 2):
        lines.append(f"{i}. {h}")
    lines.append(f"{len(headings) + 2}. 각주 섹션 (raw 문서 파일명 기반)")

    has_template = any("{국가}" in h for h in headings)
    if has_template:
        lines.append("")
        lines.append("Template rule for {국가}:")
        lines.append(
            "- Headings marked with {국가} MUST be repeated for EACH country found in the raw documents."
        )
        lines.append(
            "- Replace {국가} with the actual country name from the source documents."
        )
        lines.append(
            "- Under each country heading, include only source-grounded content that belongs to that country-specific subtree."
        )

    return "\n".join(lines)


def _build_reduce_system_prompt(doc_structure: list[str] | None = None) -> str:
    structure_block = _build_structure_block(doc_structure)
    return _REDUCE_SYSTEM_BASE.format(structure_block=structure_block)


INCREMENTAL_CREATE_SYSTEM_PROMPT = """\
You are an expert wiki author. Read the raw work documents below and create a structured wiki note.

{structure_block}

Rules:
- Use Obsidian-standard footnotes:
  - In-text: [^1][^2] (numeric, short)
  - At bottom in ## 각주 section: [^1]: [[(filename)]]
  - Omit .md extension from footnote definitions
- Every factual paragraph or bullet block MUST have at least one footnote citation. Group citations at the paragraph/block level.
- Stay grounded in raw documents. Do not invent facts. Cross-document synthesis is allowed.
- Do NOT use defensive hedging phrases such as "사례 문서에서 직접 확인된". Write direct factual sentences with footnote citations.
- Write concretely so a new team member can perform the same task using only this wiki.
- Write ALL output in Korean.
- Organize by meaning, not by exhaustive enumeration. Do NOT use comma-chain sentences with 5+ items.
- Do NOT use markdown tables (| |). Use grouped bullet lists instead.
- Use bullets for procedures/checklists, not for dumping all extracted items.
"""

INCREMENTAL_UPDATE_SYSTEM_PROMPT = """\
You are an expert wiki update author.
Read the raw work documents below and update the existing wiki with new information.

The existing wiki is provided as a JSON node array. Each node has: id, type, content, parent, indent.

Respond ONLY with a JSON array of diffs:
[
  {"action": "update", "id": 3, "content": "new content with [^N] citation"},
  {"action": "insert_after", "id": 7, "type": "list", "parent": 5, "indent": 1, "content": "added item [^N]"},
  {"action": "delete", "id": 10},
  {"action": "append_child", "parent": 4, "type": "list", "indent": 0, "content": "new list item [^N]"}
]

Rules:
- Target nodes by id (NOT by line number or text matching).
- When adding nodes: type and parent are required.
- Footnotes: use type="footnote_def", ref=number. Obsidian format: in-text [^1], bottom [^1]: [[(filename)]].
- Continue footnote numbering from the highest existing number.
- Preserve existing content; only add/modify with new information from the raw documents.
- Every new factual paragraph or bullet block MUST cite the source document via footnote.
- Remove duplicates and update with the latest information.
- Stay grounded in raw documents. Do not invent facts. Cross-document synthesis is allowed.
- Do NOT use defensive hedging phrases such as "사례 문서에서 직접 확인된". Write direct factual sentences.
- Do NOT use comma-chain sentences with 5+ items. Group items into labeled categories.
- Do NOT use markdown tables (| |).
- Write ALL content values in Korean.
"""

UPDATE_REDUCE_SYSTEM_PROMPT = """\
You are an expert wiki update author.
The existing wiki is provided as a JSON node array. Each node has: id, type, content, parent, indent.

Respond ONLY with a JSON array of diffs:
[
  {"action": "update", "id": 3, "content": "new content"},
  {"action": "insert_after", "id": 7, "type": "list", "parent": 5, "indent": 1, "content": "added item"},
  {"action": "delete", "id": 10},
  {"action": "append_child", "parent": 4, "type": "list", "indent": 0, "content": "new list item"}
]

Rules:
- Target nodes by id (NOT by line number or text matching).
- When adding nodes: type and parent are required.
- Footnotes: use type="footnote_def", ref=number.
- Preserve existing content; only add/modify with new information.
- Continue footnote numbering from the highest existing number. Obsidian format: in-text [^1], bottom [^1]: [[(filename)]].
- Remove duplicates and update with the latest information.
- Stay grounded in raw documents. Do not invent facts. Cross-document synthesis is allowed.
- Do NOT use defensive hedging phrases such as "사례 문서에서 직접 확인된". Write direct factual sentences.
- Do NOT use comma-chain sentences with 5+ items. Group items into labeled categories.
- Do NOT use markdown tables (| |).
- Write ALL content values in Korean.
"""


# ── ChunkedSynthesizer ────────────────────────────────────────────


class ChunkedSynthesizer:
    """Map-Reduce wiki synthesis from a large set of raw documents.

    Args:
        agent: Any object with a ``generate(system_prompt, user_prompt) -> str``
               method (e.g. WikiAgent, ChatGPTClient-based agent).
        batch_size: Number of documents processed per map step.
    """

    def __init__(
        self,
        agent,
        batch_size: int = 10,
        doc_structure: list[str] | None = None,
        vault_root: Path | None = None,
        country_filter: str | None = None,
        system_prompt_addendum: str | None = None,
        extract_prompt_override: str | None = None,
        compose_prompt_override: str | None = None,
        update_prompt_override: str | None = None,
    ) -> None:
        self.agent = agent
        self.doc_structure = doc_structure
        self._vault_root = vault_root
        self._country_filter = (country_filter or "").strip().lower()
        self._system_prompt_addendum = system_prompt_addendum or ""
        self._extract_prompt_override = extract_prompt_override
        self._compose_prompt_override = compose_prompt_override
        self._update_prompt_override = update_prompt_override

        # Adaptive batch size based on model
        model_name = getattr(agent, "model", "").lower()
        if "e4b" in model_name:
            self.batch_size = 5
        elif "26b" in model_name:
            self.batch_size = 15
        elif "gpt-5.4" in model_name or "gpt-4" in model_name:
            self.batch_size = 30
        else:
            self.batch_size = batch_size

    # ── Public API ────────────────────────────────────────────────

    def synthesize(
        self,
        docs: list[Path],
        existing_wiki: str | None = None,
        domain: str = "",
        reference_files: list[Path] | None = None,
        cache_dir: Path | None = None,
    ) -> tuple[str, list[str]]:
        """Synthesize docs into a wiki note via map-reduce.

        Args:
            docs: Raw document paths to synthesize.
            existing_wiki: Existing wiki note content for update mode.
                           If None, a new wiki note is created.
            domain: Domain label included in reduce prompt for context.
            reference_files: Additional reference paths (appended to docs
                             for footnote listing; not read twice if already
                             in docs).

        Returns:
            Tuple of (wiki markdown string, list of successfully processed doc paths).
        """
        if not docs:
            logger.warning("synthesize() called with empty docs list")
            return (existing_wiki or "", [])

        # Map phase — Codex SDK가 전체 문서를 1회 호출로 분석
        extractions = self._map(docs, cache_dir=cache_dir)
        if not extractions:
            return (existing_wiki or "", [])

        # Track successfully processed docs
        self._succeeded_docs: list[str] = []

        # Reduce phase
        # Codex MAP은 항상 1개 extraction을 반환 (전체 문서 통합 분석).
        if existing_wiki:
            wiki = self._update_reduce(extractions, existing_wiki, docs, domain)
        else:
            wiki = self._create_reduce(extractions, docs, domain)
            if extractions[0].get("_map_ok", True):
                self._succeeded_docs.extend(extractions[0].get("_source_paths", []))

        # Post-processing
        wiki = strip_code_blocks(wiki)
        wiki = filter_attachment_footnotes(wiki)
        wiki = canonicalize_regulation_markdown(wiki, self.doc_structure)
        wiki = dedup_footnotes_by_source(wiki)

        succeeded = list(self._succeeded_docs)
        logger.info("Successfully processed %d/%d docs", len(succeeded), len(docs))
        return (wiki, succeeded)

    # ── Map phase (Codex SDK) ────────────────────────────────────
    # 2026-04-08 대체: 배치별 agent.generate() → Codex SDK 1회 호출.
    # 기존 코드: legacy/map_legacy.py 참조.
    #
    # [작동 원리]
    # 1. 전체 문서 경로를 Codex SDK에 전달 (run_codex_prompt)
    # 2. Codex 오케스트레이터가 doc_explorer 서브에이전트를 병렬 소환
    # 3. 각 서브에이전트가 문서를 읽고 claim(사실/절차/이슈) 추출
    # 4. 오케스트레이터가 claim 누적/중복 병합/패턴 정제 → JSON 반환
    # 5. _claims_to_extractions()로 기존 REDUCE 호환 형태로 변환

    def _map(self, docs: list[Path], cache_dir: Path | None = None) -> list[dict]:
        """Codex SDK MAP: 1회 호출로 전체 문서를 분석하여 claim 추출.

        Codex 오케스트레이터가 doc_explorer 서브에이전트를 병렬 소환하여
        각 문서를 탐색하고, 구조화된 claim JSON을 반환한다.
        cwd를 vault_root로 설정하여 sandbox에서 파일 접근 가능.
        """
        if run_codex_prompt is None:
            raise RuntimeError(
                "Codex SDK not available. Install @openai/codex-sdk and "
                "ensure codex_oauth.py is importable."
            )

        # 캐시 확인
        cache_file: Path | None = None
        if cache_dir:
            cache_dir.mkdir(parents=True, exist_ok=True)
            cache_file = cache_dir / "codex_map_claims.json"
            if cache_file.exists():
                try:
                    cached = json.loads(cache_file.read_text(encoding="utf-8"))
                    logger.info(
                        "Codex MAP loaded from cache (%d claims)",
                        len(cached.get("claims", [])),
                    )
                    return self._claims_to_extractions(cached, docs)
                except Exception:
                    pass

        # Isolated sandbox directory. Codex has shell access under its cwd
        # and would otherwise discover unrelated files in the vault via
        # `ls`/`find`/`grep`. We stage the caller-supplied docs into a
        # fresh tmp directory under the nanoclaw repo and pass that as
        # cwd, so Codex's relative-path navigation can only reach the
        # files we actually want it to read.
        #
        # Files are copied (not symlinked) so that realpath() cannot
        # escape back to the original vault location. Names are kept as
        # basenames because the current layers have no basename
        # collisions; fall back to an index prefix if one ever occurs.
        nanoclaw_root = Path(__file__).resolve().parents[4]
        sandbox_root = (
            nanoclaw_root
            / "tmp"
            / f"codex_map_{int(time.time())}_{os.getpid()}"
        )
        sandbox_root.mkdir(parents=True, exist_ok=True)

        # sandbox_name → original Path, so we can rewrite doc_id after
        # Codex returns. `docs` is the authoritative whitelist.
        sandbox_docs: dict[str, Path] = {}
        for i, src in enumerate(docs, start=1):
            if not src.exists():
                logger.warning("Codex MAP: source doc missing, skipping: %s", src)
                continue
            base = src.name
            sb_name = base if base not in sandbox_docs else f"{i:03d}_{base}"
            dst = sandbox_root / sb_name
            try:
                dst.write_bytes(src.read_bytes())
                sandbox_docs[sb_name] = src
            except OSError as exc:
                logger.warning(
                    "Codex MAP: failed to stage %s into sandbox: %s", src, exc
                )

        if not sandbox_docs:
            logger.error("Codex MAP: no docs staged in sandbox, aborting")
            shutil.rmtree(sandbox_root, ignore_errors=True)
            return []

        doc_list_file = sandbox_root / "_codex_doc_list.md"
        doc_list_file.write_text(
            "\n".join(f"- [ ] {name}" for name in sandbox_docs), encoding="utf-8"
        )
        doc_log_dir = sandbox_root / "_codex_map_log"
        doc_log_dir.mkdir(parents=True, exist_ok=True)

        prompt_template = self._extract_prompt_override or CODEX_MAP_PROMPT_TEMPLATE
        # Inside the sandbox cwd, paths are plain basenames. Give Codex
        # the relative path to the list file so it does not wander.
        prompt = prompt_template.format(
            doc_count=len(sandbox_docs),
            doc_listing=(
                "문서 경로 목록은 현재 작업 디렉토리의 `_codex_doc_list.md` "
                "파일에 한 줄에 하나씩 저장되어 있습니다. `cat _codex_doc_list.md`로 읽으세요. "
                "목록에 있는 파일명은 작업 디렉토리 기준 단순 basename이며, "
                "`cat <파일명.md>`로 바로 읽을 수 있습니다."
            ),
            doc_log_dir="_codex_map_log",
        )

        logger.info(
            "Codex MAP: %d docs 전송 (sandbox=%s)...",
            len(sandbox_docs),
            sandbox_root,
        )
        start = time.time()

        # From this point on, the sandbox tmp directory MUST be removed
        # regardless of how we exit (success, parse error, no claims,
        # exception). All subsequent returns are routed through the
        # finally block at the end of this method.
        try:
            result = run_codex_prompt(
                prompt=prompt,
                cwd=str(sandbox_root),
                reasoning_effort="high",
                output_schema=CODEX_MAP_CLAIM_SCHEMA,
            )

            elapsed = time.time() - start
            logger.info("Codex MAP 완료: %.1fs (ok=%s)", elapsed, result["ok"])

            if not result["ok"]:
                logger.error("Codex MAP failed: %s", result["message"])
                return []

            # 응답 파싱 (디버그: raw output 로깅)
            raw_output = result.get("output", "")
            logger.info(
                "Codex MAP raw output (first 1000 chars): %.1000s", raw_output
            )
            claims_data = self._parse_codex_response(raw_output)
            if claims_data is None:
                logger.error("Codex MAP response is not valid JSON")
                return []

            # FILE_ACCESS_DENIED 감지
            if claims_data.get("error") == "FILE_ACCESS_DENIED":
                failed = claims_data.get("failed_files", [])
                logger.error(
                    "Codex MAP: FILE_ACCESS_DENIED — %d files. Check sandbox cwd. Failed: %s",
                    len(failed),
                    failed[:5],
                )
                return []

            claims = claims_data.get("claims", [])
            logger.info("Codex MAP: %d claims", len(claims))

            # Defensive filter: Codex's sandbox cwd now contains ONLY the
            # staged files, but absolute paths outside cwd are still
            # technically readable. If any claim's doc_id does not map to
            # one of the staged sandbox filenames, drop it. Also rewrite
            # surviving claims' doc_id back to the original (vault) file's
            # basename so downstream code (footnote wiring, Grounding
            # rubric, etc.) sees the canonical name.
            allowed_sandbox_names = set(sandbox_docs.keys())

            def _resolve_doc_id(raw: object) -> str | None:
                """Map a Codex-returned doc_id to its sandbox filename, or None."""
                if not isinstance(raw, str) or not raw:
                    return None
                for token in raw.split(";"):
                    token = token.strip()
                    if not token:
                        continue
                    base = Path(token).name
                    if base in allowed_sandbox_names:
                        return base
                    # Tolerate stem-only ids (e.g. "L00013" vs "L00013 Tobacco...md").
                    for sb_name in allowed_sandbox_names:
                        if sb_name.startswith(base) or base in sb_name:
                            return sb_name
                return None

            original_count = len(claims)
            cleaned: list[dict] = []
            for c in claims:
                resolved = _resolve_doc_id(c.get("doc_id"))
                if resolved is None:
                    continue
                original = sandbox_docs[resolved]
                c["doc_id"] = original.name
                cleaned.append(c)
            claims = cleaned
            dropped = original_count - len(claims)
            if dropped:
                logger.warning(
                    "Codex MAP defensive filter dropped %d/%d claims with off-list doc_ids "
                    "(allowed sandbox files: %s)",
                    dropped,
                    original_count,
                    sorted(allowed_sandbox_names)[:5],
                )

            # 문서별 처리 로그 수집 (per-doc JSON files → merged log)
            if doc_log_dir.exists() and cache_dir:
                doc_log_entries = []
                for log_file in doc_log_dir.glob("*.json"):
                    try:
                        entry = json.loads(log_file.read_text(encoding="utf-8"))
                        doc_log_entries.append(entry)
                    except (json.JSONDecodeError, OSError):
                        doc_log_entries.append(
                            {
                                "doc": log_file.stem,
                                "claims": -1,
                                "reason": "log parse error",
                            }
                        )
                if doc_log_entries:
                    doc_log_dest = cache_dir / "codex_map_doc_log.json"
                    doc_log_dest.write_text(
                        json.dumps(doc_log_entries, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    skipped = sum(
                        1 for d in doc_log_entries if d.get("claims", 0) == 0
                    )
                    logger.info(
                        "Codex MAP doc log: %d entries (%d with claims, %d skipped) → %s",
                        len(doc_log_entries),
                        len(doc_log_entries) - skipped,
                        skipped,
                        doc_log_dest,
                    )
                else:
                    logger.warning("Codex MAP doc log directory is empty")

            if not claims:
                logger.error("Codex MAP produced 0 claims from %d docs", len(docs))
                return []

            # Update claims_data with the filtered/rewritten claims so the
            # cache and downstream extractions stay consistent with what we
            # actually returned.
            claims_data["claims"] = claims

            # 캐시 저장
            if cache_file:
                try:
                    cache_file.write_text(
                        json.dumps(claims_data, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                except Exception:
                    logger.warning("Failed to write Codex MAP cache")

            return self._claims_to_extractions(claims_data, docs)
        finally:
            shutil.rmtree(sandbox_root, ignore_errors=True)

    @staticmethod
    def _parse_codex_response(output: str) -> dict | None:
        """Parse Codex MAP JSON response, with fallback extraction."""
        if not output:
            return None
        try:
            return json.loads(output)
        except (json.JSONDecodeError, TypeError):
            match = re.search(r"\{[\s\S]*\}", output)
            if match:
                try:
                    return json.loads(match.group())
                except json.JSONDecodeError:
                    return None
            return None

    @staticmethod
    def _claims_to_extractions(claims_data: dict, docs: list[Path]) -> list[dict]:
        """Convert Codex claim JSON to REDUCE-compatible extraction format."""
        claims = claims_data.get("claims", [])

        # 주제별 상세 블록 (REDUCE가 이 내용을 참조하여 wiki 작성)
        detailed_topics = []
        keywords: set[str] = set()
        for c in claims:
            haystacks = [
                c.get("claim", ""),
                c.get("detail", ""),
                c.get("doc_id", ""),
                c.get("quote", ""),
            ]
            joined = " ".join(part for part in haystacks if isinstance(part, str))
            if any(token in joined for token in _META_CLAIM_TOKENS):
                continue

            items = c.get("items", []) or []
            item_legal_basis = c.get("item_legal_basis", []) or []
            claim_title = c.get("claim", "")
            detail = c.get("detail", "")
            legal_basis = c.get("legal_basis", "")
            quote = c.get("quote", "")
            doc_id = c.get("doc_id", "")
            section_target = _sanitize_section_target(c.get("section_target", ""))
            confidence = c.get("confidence", "medium")

            can_expand_atomic = (
                item_legal_basis
                and len(item_legal_basis) == len(items)
                and len(items) > 1
            )

            if can_expand_atomic:
                for idx, (item_text, item_basis) in enumerate(
                    zip(items, item_legal_basis)
                ):
                    atomic_topic = {
                        "주제": f"{claim_title} ({idx + 1}/{len(items)})",
                        "상세": item_text,
                        "목록": [],
                        "법적근거": item_basis or legal_basis,
                        "원문인용": quote,
                        "출처": doc_id,
                        "섹션": section_target,
                        "신뢰도": confidence,
                    }
                    detailed_topics.append(atomic_topic)
            else:
                topic = {
                    "주제": claim_title,
                    "상세": detail,
                    "목록": items,
                    "법적근거": legal_basis,
                    "원문인용": quote,
                    "출처": doc_id,
                    "섹션": section_target,
                    "신뢰도": confidence,
                }
                detailed_topics.append(topic)

            for word in claim_title.split():
                if len(word) > 2:
                    keywords.add(word)

        extraction = {
            "상세주제": detailed_topics,
            "주요_키워드": list(keywords)[:20],
            "_sources": [p.name for p in docs],
            "_source_paths": [str(p) for p in docs],
            "_map_ok": True,
        }

        return [extraction]

    def _build_batch_text(self, batch: list[Path]) -> str:
        """Build concatenated text from a batch of docs (used by incremental mode)."""
        parts: list[str] = []
        for path in batch:
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as exc:
                logger.warning("Cannot read %s: %s", path, exc)
                content = "(읽기 실패)"
            parts.append(f"--- {path.name} ---\n{content}")

            # Follow wikilinks up to max_depth=2
            if self._vault_root:
                linked = _resolve_wikilinks(content, self._vault_root, max_depth=2)
                for link_path, link_content in linked:
                    if self._country_filter and not _matches_country_filter(
                        link_path, link_content, self._country_filter
                    ):
                        continue
                    parts.append(
                        f"--- [참조됨: {path.name} → {link_path.name}] ---\n{link_content}"
                    )

        return "\n\n".join(parts)

    # ── Reduce phase ──────────────────────────────────────────────

    def _create_reduce(
        self, extractions: list[dict], docs: list[Path], domain: str
    ) -> str:
        """Reduce extractions into a new wiki note."""
        user_prompt = self._build_reduce_user_prompt(extractions, docs, domain)
        if self._compose_prompt_override:
            structure_block = _build_structure_block(self.doc_structure)
            system_prompt = (
                self._compose_prompt_override.format(structure_block=structure_block)
                + self._system_prompt_addendum
            )
        else:
            system_prompt = (
                _build_reduce_system_prompt(self.doc_structure)
                + self._system_prompt_addendum
            )
        return self.agent.generate(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
        )

    def _update_reduce(
        self,
        extractions: list[dict],
        existing_wiki: str,
        docs: list[Path],
        domain: str,
    ) -> str:
        """Iteratively merge extractions into an existing wiki note using JSON node diffs."""
        current_wiki = existing_wiki

        for i, ext in enumerate(extractions):
            logger.info("Updating wiki with extraction %d/%d", i + 1, len(extractions))

            nodes = md_to_json(current_wiki)
            ext_text = json.dumps(ext, ensure_ascii=False, indent=2)
            sources = ext.get("_sources", [])
            source_list = "\n".join(f"- {s}" for s in sources)
            domain_line = f"도메인: {domain}\n\n" if domain else ""

            nodes_json = json.dumps(
                [n.model_dump() for n in nodes], ensure_ascii=False, indent=2
            )
            user_prompt = (
                f"{domain_line}"
                f"기존 wiki (JSON 노드):\n{nodes_json}\n\n"
                f"신규 추출 패턴:\n{ext_text}\n\n"
                f"=== 이번 배치 raw 문서 목록 ===\n{source_list}"
            )

            diff_response = self.agent.generate(
                system_prompt=(
                    self._update_prompt_override or UPDATE_REDUCE_SYSTEM_PROMPT
                )
                + self._system_prompt_addendum,
                user_prompt=user_prompt,
            )

            # Apply JSON node diffs to current wiki
            prev_wiki = current_wiki
            current_wiki = self._apply_section_diffs(
                current_wiki, diff_response, existing_wiki
            )

            # Track success: wiki changed means diffs were applied
            if current_wiki != prev_wiki and ext.get("_map_ok", True):
                self._succeeded_docs.extend(ext.get("_source_paths", []))

        current_wiki = canonicalize_regulation_markdown(
            current_wiki, self.doc_structure
        )
        current_wiki = preserve_canonical_subtrees(current_wiki, existing_wiki)
        current_wiki = merge_missing_footnote_definitions(current_wiki, existing_wiki)
        current_wiki = dedup_footnotes_by_source(current_wiki)
        return current_wiki

    # ── Incremental (single-pass) synthesis ──────────────────────

    def synthesize_incremental(
        self,
        docs: list[Path],
        existing_wiki: str | None = None,
        domain: str = "",
        cache_dir: Path | None = None,
    ) -> tuple[str, list[str]]:
        """Single-pass incremental synthesis: raw docs → wiki directly (no MAP phase).

        Each batch of raw documents is fed directly to the LLM along with the
        current wiki state.  The LLM generates MdDiff operations to integrate
        new information.  This avoids the 2-pass overhead of map-reduce and
        preserves original document detail better.

        Returns:
            Tuple of (wiki markdown string, list of successfully processed doc paths).
        """
        if not docs:
            logger.warning("synthesize_incremental() called with empty docs list")
            return (existing_wiki or "", [])

        # Smaller batch size for incremental — raw text is larger than pattern JSON
        inc_batch_size = min(10, self.batch_size)
        batches = self._batch(docs, inc_batch_size)
        wiki = existing_wiki or ""
        succeeded: list[str] = []

        inc_cache_dir: Path | None = None
        if cache_dir:
            inc_cache_dir = cache_dir / "incremental_cache"
            inc_cache_dir.mkdir(parents=True, exist_ok=True)

        for i, batch in enumerate(batches):
            cache_file = inc_cache_dir / f"step_{i}.md" if inc_cache_dir else None

            # Try loading cached wiki state
            if cache_file and cache_file.exists():
                try:
                    wiki = cache_file.read_text(encoding="utf-8")
                    logger.info(
                        "Incremental batch %d/%d loaded from cache", i + 1, len(batches)
                    )
                    succeeded.extend(str(p) for p in batch)
                    continue
                except Exception:
                    pass

            logger.info(
                "Incremental batch %d/%d (%d docs)", i + 1, len(batches), len(batch)
            )
            raw_text = self._build_batch_text(batch)
            source_list = "\n".join(f"- {p.name}" for p in batch)
            domain_line = f"도메인: {domain}\n\n" if domain else ""

            if not wiki:
                # First batch, no existing wiki → create from scratch
                system_prompt = INCREMENTAL_CREATE_SYSTEM_PROMPT.format(
                    structure_block=_build_structure_block(self.doc_structure),
                )
                user_prompt = (
                    f"{domain_line}"
                    f"=== raw 문서 ({len(batch)}건) ===\n\n{raw_text}\n\n"
                    f"=== 문서 목록 (각주용) ===\n{source_list}"
                )
                wiki = self.agent.generate(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
                wiki = strip_code_blocks(wiki)
            else:
                # Subsequent batches → update existing wiki via MdDiff
                nodes = md_to_json(wiki)
                nodes_json = json.dumps(
                    [n.model_dump() for n in nodes],
                    ensure_ascii=False,
                    indent=2,
                )
                user_prompt = (
                    f"{domain_line}"
                    f"기존 wiki (JSON 노드):\n{nodes_json}\n\n"
                    f"=== 신규 raw 문서 ({len(batch)}건) ===\n\n{raw_text}\n\n"
                    f"=== 이번 배치 문서 목록 (각주용) ===\n{source_list}"
                )
                diff_response = self.agent.generate(
                    system_prompt=INCREMENTAL_UPDATE_SYSTEM_PROMPT,
                    user_prompt=user_prompt,
                )
                prev_wiki = wiki
                wiki = self._apply_section_diffs(wiki, diff_response)

                if wiki == prev_wiki:
                    logger.warning("Incremental batch %d produced no changes", i + 1)

            succeeded.extend(str(p) for p in batch)

            # Cache wiki state after this batch
            if cache_file:
                try:
                    cache_file.write_text(wiki, encoding="utf-8")
                except Exception:
                    logger.warning(
                        "Failed to write incremental cache for batch %d", i + 1
                    )

        # Post-processing
        wiki = strip_code_blocks(wiki)
        wiki = filter_attachment_footnotes(wiki)

        logger.info(
            "Incremental synthesis: %d/%d docs succeeded", len(succeeded), len(docs)
        )
        return (wiki, succeeded)

    def _apply_section_diffs(
        self, original: str, response: str, reference_wiki: str | None = None
    ) -> str:
        """Apply JSON node diffs from LLM response."""
        nodes = md_to_json(original)
        try:
            diffs = parse_validated_list(response, MdDiff)
        except ValueError as exc:
            logger.warning(
                "MdDiff parse failed, keeping original. error=%s response_preview=%.500s",
                exc,
                response,
            )
            return original
        if not diffs:
            logger.warning(
                "MdDiff response yielded 0 valid diffs. response_preview=%.500s",
                response,
            )
            return original
        logger.info("Applying %d MdDiff operations", len(diffs))
        updated = apply_json_diffs(nodes, diffs)
        updated_md = canonicalize_regulation_markdown(
            json_to_md(updated), self.doc_structure
        )
        updated_md = preserve_canonical_subtrees(updated_md, reference_wiki or original)
        updated_md = merge_missing_footnote_definitions(
            updated_md, reference_wiki or original
        )
        return dedup_footnotes_by_source(updated_md)

    def _build_reduce_user_prompt(
        self, extractions: list[dict], docs: list[Path], domain: str
    ) -> str:
        extractions_text = _format_extractions(extractions)
        source_list = "\n".join(f"- {p.name}" for p in docs)
        domain_line = f"도메인: {domain}\n\n" if domain else ""

        return (
            f"{domain_line}"
            f"=== 배치별 추출 패턴 ({len(extractions)}개 배치) ===\n{extractions_text}\n\n"
            f"=== raw 문서 목록 (각주 참조용) ===\n{source_list}"
        )

    # ── Helpers ───────────────────────────────────────────────────

    @staticmethod
    def _batch(items: list[Path], size: int) -> list[list[Path]]:
        return [items[i : i + size] for i in range(0, len(items), size)]


# ── Wikilink resolution ──────────────────────────────────────────

_WIKILINK_RE = re.compile(r"\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]")


def _resolve_wikilinks(
    content: str,
    vault_root: Path,
    max_depth: int = 2,
    _depth: int = 0,
    _seen: set[str] | None = None,
) -> list[tuple[Path, str]]:
    """Follow Obsidian wikilinks to .md files and return (path, content) pairs.

    - Only .md files are followed (non-md links are skipped)
    - Recurses up to max_depth levels
    - Deduplicates by filename to avoid cycles
    """
    if _depth >= max_depth:
        return []
    if _seen is None:
        _seen = set()

    results: list[tuple[Path, str]] = []
    links = _WIKILINK_RE.findall(content)

    for link_name in links:
        link_name = link_name.strip()
        if link_name in _seen:
            continue
        _seen.add(link_name)

        resolved = _find_in_vault(link_name, vault_root)
        if resolved is None or resolved.suffix.lower() != ".md":
            continue

        try:
            text = resolved.read_text(encoding="utf-8")
            results.append((resolved, text))
            if _depth + 1 < max_depth:
                results.extend(
                    _resolve_wikilinks(text, vault_root, max_depth, _depth + 1, _seen)
                )
        except Exception as exc:
            logger.debug("Cannot read linked %s: %s", resolved, exc)

    return results


def _find_in_vault(name: str, vault_root: Path) -> Path | None:
    """Find a file by name in the vault (Obsidian-style shortest match)."""
    if "." not in name.split("/")[-1]:
        name += ".md"

    direct = vault_root / name
    if direct.exists():
        return direct

    target = name.split("/")[-1]
    matches = list(vault_root.rglob(target))
    return matches[0] if matches else None


def _matches_country_filter(path: Path, content: str, country_filter: str) -> bool:
    path_blob = " ".join(part.lower() for part in path.parts)
    if country_filter and country_filter in path_blob:
        return True

    if content.startswith("---"):
        end = content.find("---", 3)
        if end > 0:
            fm = content[3:end].lower()
            if f"country: {country_filter}" in fm:
                return True

    return False


# ── Module-level helpers ──────────────────────────────────────────


def _format_extractions(extractions: list[dict]) -> str:
    """Pretty-print list of extraction dicts for the reduce prompt."""
    parts: list[str] = []
    for i, ext in enumerate(extractions, 1):
        sources = ext.get("_sources", [])
        sources_str = ", ".join(sources) if sources else "unknown"
        try:
            text = json.dumps(ext, ensure_ascii=False, indent=2)
        except Exception:
            text = str(ext)
        parts.append(f"--- 배치 {i} (출처: {sources_str}) ---\n{text}")
    return "\n\n".join(parts)
