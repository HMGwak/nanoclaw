# Wiki Quality Log

tobacco_regulation (country=Germany) 파이프라인의 반복 품질 개선 로그.  
매 실행마다 점수와 구조 품질을 기록한다.

## 포맷

각 cycle은 다음을 기록:
- **Run ID**: 실행 디렉토리 ID
- **Commit**: git SHA (현재는 non-git repo이므로 변경 내역 요약)
- **Layer2 / Layer3 scores**: iteration별 최종 점수 + best
- **Structure quality**: 예상 canonical 헤딩 33개 중 실존
- **Footnote dedup**: 고유 source 대비 실제 정의 수
- **Prompt version**: REVISE_BASE / COMPOSE 주요 버전 표지
- **Issues found**: 수동 리뷰에서 발견한 문제
- **Next fix**: 다음 cycle에 시도할 조정

---

## Cycle 0 — Baseline (2026-04-15, pre-QA)

**Run ID**: `3c26c518`  
**Prompt version**: v0 (balance 언어 있음, level off-by-one, footnote dedup 없음)

- Layer1: 76.6 (e4365c9d 재사용)
- Layer2: iter1=58.2 → iter2=**78.2 (best)** → iter3=76.6 → max_iterations
- Layer3: iter1=63.7 → iter2=68.4 → iter3=**70.1 (best)** → converged

**Structure**: 붕괴 (중복 h2 wrapper, h3 scaffold 누락, 규제 요건만 존재)  
**Footnotes**: 27개 정의 (원문 4개에서 13/4/3/1/1 duplicate)  
**Issues**:
1. 중복 footnote 정의 (L00013 13개)
2. canonical structure 붕괴 (신규제출/변경제출/정기제출 h2 없음)
3. Coverage rubric의 "balanced" 언어로 balance 강제

**Applied fixes**: (cycle 1에서 검증)
1. `dedup_footnotes_by_source()` 신규
2. `canonicalize_regulation_markdown` 레벨 alignment (h1/h2/h3 matching spec)
3. `_merge_submission_section` 항상 h3 scaffold 생성
4. `preserve_canonical_subtrees` h1 parser
5. Coverage anchors 3 layers "balanced" → "source-grounded", "empty OK"
6. REVISE_BASE_INSTRUCTIONS rule 6 "depth imbalance" → "leave empty marker as-is"

---

## Cycle 1 — Structure + Footnote + Balance 1차 (2026-04-15)

**Run ID**: `e3888164` (실행 21:43 ~ 21:54)  
**Prompt version**: v1

**Code fixes applied (이전 cycle 대비):**
- `markdown_utils.dedup_footnotes_by_source()` 신규 (post-process dedup + 순차 재번호)
- `canonicalize_regulation_markdown` level alignment (h2→h1, h3→h2, h4→h3)
- `_merge_submission_section`: 신규제출/변경제출/정기제출에 항상 h3 scaffold 생성
- `preserve_canonical_subtrees`: h2 parser → h1 parser
- Footnote def를 section 콘텐츠에서 제외, 문서 끝으로 hoist
- `REVISE_BASE_INSTRUCTIONS` rule 6: "depth imbalance 줄이기" → "empty marker 유지"
- `REVISE_SYSTEM_PROMPT_IMPROVE`: "depth imbalance" → "missing citations"
- Coverage anchors (3 layers): "balanced" → "source-grounded", "empty OK" 추가
- task.py/synthesizer.py 4개 call site에 `dedup_footnotes_by_source` 연결

### Scores

| Layer | iter1 | iter2 | iter3 | Final | Status | Δ vs cycle 0 |
|---|---|---|---|---|---|---|
| layer2 | 82.0 | **84.0** | — | 84.0 | converged | +5.8 |
| layer3 | 66.0 | **72.1** | 70.1 | 72.1 | max_iterations (rollback) | +2.0 |

**Layer2 breakdown (iter2):** Citation 14.2 / Coverage 21 / Grounding 24 / Actionability 12 / Restraint 8 / Markdown 4.8  
**Layer3 breakdown (iter2):** Citation 14.3 / Coverage 12 / Grounding 20 / Actionability 14 / Restraint 7 / Markdown 4.8

### Structure & Footnote

- Canonical headings: **33/33 present** (4 h1 + 11 h2 + 18 h3)
- Footnote defs: **5 unique** (L00013/L00012/L00003/[[Regulatory_Survey]]/[[Negative_list]])
- 순차 재번호: `[^1]`~`[^5]` 연속
- 최종 wiki: 204줄, 26KB

### Issues found (manual review)

1. **일부 content가 bullet이 아닌 paragraph로 렌더링** (예: `## 변경제출 > ### 제출 대상 및 자료`의 첫 줄 "변경으로 기존 통지정보에 영향을..."). compose prompt "Prefer bullets over long prose" 준수 필요.
2. **섹션 간 빈 줄 과다** (`\n\n\n` 패턴). canonicalize 또는 json_to_md 쪽 정리 필요.
3. **Layer3 실무 enrichment가 때때로 같은 내용의 bullet을 중복 생성** (Negative list 사례 3개 정도 동일 주장).
4. **Markdown Formatting 점수 고정 4.8/5** (7 issues / 148+ items). L184, L189 등 "footnote not wikilink format" 경고 — bullet 내 footnote는 wiki-link 형식이 아니라 plain `[^N]` 사용하는 게 현재 방침인데 checker가 경고. 체커 조정 또는 무시 필요.

### Next fix (cycle 2 계획)

- **2-1**: compose prompt 강화 — "모든 substantive content는 반드시 bullet 형식. 서술형 문단 금지"
- **2-2**: canonicalize 정리 — 연속 blank line `\n\n\n` → `\n\n`으로 축소 (이미 부분 적용돼 있지만 검증 필요)
- **2-3**: Layer3 compose/revise prompt — 유사 주장 중복 생성 억제 "유사 실무 사례 중복 금지"
- **2-4**: Markdown Formatting checker 자체 조정 or 경고 형식 탈락 (footnote wiki-link format 경고가 무의미)

---

## Cycle 2 — bullet-only + dedup + blank normalize (2026-04-15)

**Run ID**: `aafdb05d` (실행 22:04 ~ 22:16)  
**Prompt version**: v2

**Code/prompt fixes applied:**
- Layer1 compose prompt: "EVERY substantive content block MUST be bullet"
- Layer1 compose prompt: 중복 bullet 금지 규칙
- Layer2/3 update prompts: MdDiff `type: "list"` 강제
- Layer2/3 update prompts: 동일 주장 중복 bullet 금지
- `canonicalize_regulation_markdown`: 연속 blank line 정규화, orphan paragraph → bullet 자동 변환 (safety net)

### Scores

| Layer | iter1 | iter2 | iter3 | Final | Status | Δ vs cycle 1 |
|---|---|---|---|---|---|---|
| layer2 | 84.0 | 80.0 | **86.0** | **86.0** | **keep** 🎯 | +2.0 |
| layer3 | **81.0** | 73.7 | 80.0 | 81.0 | max_iterations (rollback) | +8.9 |

**Layer2**: iter2 하락(84→80) 후 iter3 반등 86. best_snapshot rollback 덕분.  
**Layer3**: iter1 이미 81, best_snapshot = iter1의 81.

### Structure & Footnote
- Canonical headings: **33/33 present**
- Footnote defs: **5 unique**
- 최종 wiki: 189줄, 25KB
- Orphan paragraphs 안전망 테스트: 3 → 0 (canonicalize 재실행 시)

### Issues found
1. layer1 stale output에 일부 paragraph 남아있음 (compose 재실행 필요)
2. 분석결과제출 > 규제 요건에 empty marker 버블 밖 잔존 의심
3. Coverage 여전히 개선 여지 (layer2 22/30, layer3 14/25)

### Next fix (cycle 3)
- **3-1**: layer1 fresh run으로 compose v2 검증
- **3-2**: stale output cleanup 확인
- **3-3**: empty marker 중복 조사

---

## Cycle 3 — Full fresh run + 중대 버그 발견 (2026-04-15)

**Run ID**: `69c25e2f` (실행 22:17 ~ 22:44, **BUGGY RESULT**)  
**Prompt version**: v2 (코드 변경 없음)

**실행 조건**: `--force-rebuild` + layer1 fresh (resume 없음)

### Scores

| Layer | iter1 | iter2 | iter3 | Final | Status |
|---|---|---|---|---|---|
| layer1 | **81.8** | 80.3 | 76.1 | 81.8 | max_iterations (rollback from iter1) |
| layer2 | 78.8 | **81.3** | — | 81.3 | converged |
| layer3 | 58.3 | 62.3 | **67.1** | 67.1 | max_iterations |

### 🚨 중대 버그 발견

**문제**: Layer2/3이 Germany 필터와 무관한 문서를 읽고 claim 생성
- Layer2 입력: `독일_KTG__Regulatory_Survey_Germany.md` (1개)
- Layer2 실제 claims: 7개 전부 **인도네시아** (`인도네시아_KTG Regulatory Survey - Indonesia ABNR`)
- Layer3 입력: `(규제준수)_독일 Negative list 물질 확인_육동민.md`
- Layer3 실제 claims: 13개 **나이지리아/헝가리** 사례

**원인**: Codex가 sandbox에서 vault 전체에 read 권한 있어서, `_codex_doc_list.md`의 공식 목록을 무시하고 다른 국가 문서를 자유롭게 읽음. 프롬프트에 "목록 외 파일 금지" 명시가 없었음.

**증거**: `69c25e2f/layer2/iter_1/codex_map_claims.json` 모든 claim이 Indonesia doc_id

### Cycle 3 최종 상태

- 최종 wiki는 **완전히 오염된 상태** (인도네시아 + 나이지리아 내용 섞임)
- 구조/헤딩은 올바름 (33/33)
- Footnote는 3개만 (layer2/3이 잘못된 소스라 dedup 후 합쳐지지 않음)
- **최종 wiki 사용 불가**

### Cycle 3 fixes (cycle 4용)

- **3-bugfix-1**: `CODEX_MAP_PROMPT_TEMPLATE`에 "⚠️ 절대 규칙: 파일 접근 제한" 섹션 추가
  - "오직 위 목록 파일에 나열된 문서만 읽을 수 있습니다"
  - "ls, find, grep, cat 등으로 목록에 없는 파일을 찾거나 읽지 마세요"
  - "목록 외 파일에서 나온 claim을 반환하면 전체 출력이 실패로 간주됩니다"
- **3-bugfix-2**: `ChunkedSynthesizer._map`에 런타임 방어 필터 — Codex가 반환한 claim의 doc_id가 docs 파라미터와 일치하지 않으면 drop
  - basename / vault-relative / substring 매칭으로 너그럽게 검사
  - 필터링된 개수 WARNING 로그

---


