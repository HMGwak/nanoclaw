# Rubric: Wiki Automation

## 설정
- keep_threshold: 85
- discard_threshold: 70
- max_iterations: 3
- convergence_delta: 3

## 평가 항목

### Footnote Ratio
- **타입**: 정량
- **배점**: 25
- **하드 게이트**: 0.8
- **설명**: wiki note 본문의 서술 문장 중 raw 출처 각주([^...])가 달린 비율

#### 측정 방법
```python
import re
def measure(output_files, reference_files):
    for f in output_files:
        text = f.read_text()
        sentences = [s.strip() for s in re.split(r'[.?!]\s', text) if s.strip()]
        # 헤딩, 빈줄, YAML frontmatter 제외
        sentences = [s for s in sentences if not s.startswith('#') and not s.startswith('---')]
        if not sentences:
            return {"value": 0.0, "detail": "서술 문장 없음"}
        cited = sum(1 for s in sentences if re.search(r'\[\^[^\]]+\]', s))
        ratio = cited / len(sentences)
        return {"value": round(ratio, 3), "detail": f"{cited}/{len(sentences)} 문장에 각주"}
```

### Country Sections
- **타입**: 정량
- **배점**: 0
- **하드 게이트**: 3
- **설명**: wiki note의 마크다운 헤딩 중 국가명을 포함하는 섹션 수

#### 측정 방법
```python
import re
COUNTRIES = ["한국", "미국", "일본", "중국", "EU", "영국", "독일", "프랑스", "캐나다", "호주"]
def measure(output_files, reference_files):
    for f in output_files:
        text = f.read_text()
        headings = re.findall(r'^#{1,3}\s+(.+)$', text, re.MULTILINE)
        count = sum(1 for h in headings if any(c in h for c in COUNTRIES))
        return {"value": count, "detail": f"국가 섹션 {count}개"}
```

### Example Count
- **타입**: 정량
- **배점**: 0
- **하드 게이트**: 3
- **설명**: wiki note 내 대표 사례/예시 블록 수

#### 측정 방법
```python
import re
def measure(output_files, reference_files):
    for f in output_files:
        text = f.read_text()
        keywords = ["사례", "case", "예시", "example", "예:"]
        count = sum(len(re.findall(rf'(?i)\b{kw}\b', text)) for kw in keywords)
        return {"value": count, "detail": f"사례 키워드 {count}건"}
```

### Coverage
- **타입**: 정성
- **배점**: 25
- **하드 게이트**: 없음
- **설명**: wiki note가 해당 주제의 핵심 측면을 얼마나 포괄하는지

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–5 | 주제의 한 측면만 언급. 핵심 개념 대부분 누락 | raw에서 토픽 10개 추출 가능한데 1~2개만 다룸 |
| 6–10 | 2~3개 측면을 다루나 주요 하위 주제 누락 | 커버 비율 20~40% |
| 11–15 | 핵심 하위 주제 대부분 존재, 깊이 불균일 | 커버 비율 40~60%. 일부 섹션이 1줄짜리 |
| 16–20 | 모든 핵심 하위 주제, 깊이 균일 | 커버 비율 60~80%. 각 섹션 2문단+ |
| 21–25 | 핵심 + 엣지 케이스까지 포괄 | 커버 비율 80%+. family note 간 중복 없이 보완적 |

### Grounding Accuracy
- **타입**: 정성
- **배점**: 25
- **하드 게이트**: 없음
- **설명**: 각주가 가리키는 raw 문서와 wiki note의 주장이 실제로 일치하는지

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–5 | 각주가 있으나 내용 불일치 다수 | 인용한 raw와 wiki 주장이 다른 경우 3건+ |
| 6–10 | 주요 주장은 일치하나 세부 수치/날짜 불일치 | 날짜나 금액이 다른 경우 존재 |
| 11–15 | 대부분 일치하나 1~2건 미묘한 차이 | 맥락 미세 왜곡 |
| 16–20 | 모든 핵심 주장이 raw와 정확히 일치 | 불일치 없음 |
| 21–25 | 정확한 일치 + raw의 뉘앙스까지 보존 | 조건부 진술의 조건까지 충실히 반영 |

### Discrimination
- **타입**: 정성
- **배점**: 10
- **하드 게이트**: 없음
- **설명**: 동일 family 내 다른 wiki note와의 의미적 중복이 없는지

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–2 | 내용 50%+ 중복 | family note와 핵심 섹션이 거의 동일 |
| 3–4 | 중복 20~50% | 도입부와 일부 절차가 겹침 |
| 5–6 | 중복 10~20% | 배경 설명만 겹침 |
| 7–8 | 중복 < 10% | 각 note 고유 영역 명확 |
| 9–10 | 중복 없음 | 상호 참조 적절, 독립적 완결 |

### Actionability
- **타입**: 정성
- **배점**: 10
- **하드 게이트**: 없음
- **설명**: 신규 담당자가 wiki note만으로 업무를 수행할 수 있는지

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–2 | 추상적 설명만, 절차 없음 | "서류를 준비한다" — 목록/양식/기한 없음 |
| 3–4 | 일부 절차 있으나 실행 불가 | 서류 목록은 있으나 작성법 누락 |
| 5–6 | 주요 절차 있으나 예외 미흡 | 정상 케이스만, 반려 시 대응 없음 |
| 7–8 | 절차·기준·분기 대부분 갖춤 | 정상+예외, 기한, 담당 부서 명시 |
| 9–10 | 완전한 가이드 | 신규 담당자 즉시 수행 가능, FAQ 포함 |

### Markdown Formatting
- **타입**: 정량
- **배점**: 5
- **하드 게이트**: 없음
- **설명**: Obsidian 호환 마크다운 형식 준수 여부. 인덴트는 4칸(스페이스), 리스트/넘버링/불렛 올바른 형식.

#### 측정 방법
```python
import re
def measure(output_files, reference_files):
    for f in output_files:
        text = f.read_text()
        lines = text.splitlines()
        issues = []
        for i, line in enumerate(lines, 1):
            stripped = line.lstrip()
            if not stripped.startswith(('-', '*', '+')) and not re.match(r'\d+\.', stripped):
                continue
            indent = len(line) - len(stripped)
            # 인덴트가 있으면 4의 배수여야 함 (Obsidian 기준)
            if indent > 0 and indent % 4 != 0:
                issues.append(f"L{i}: indent {indent} (not multiple of 4)")
            # 탭 사용 감지
            if '\t' in line:
                issues.append(f"L{i}: tab character found")
            # 불렛 뒤 공백 누락
            if re.match(r'^(\s*[-*+])\S', line):
                issues.append(f"L{i}: no space after bullet")
            # 넘버링 뒤 공백 누락
            if re.match(r'^(\s*\d+\.)\S', line):
                issues.append(f"L{i}: no space after number")
        total_list_lines = sum(1 for l in lines if l.lstrip().startswith(('-','*','+')) or re.match(r'\s*\d+\.', l))
        if total_list_lines == 0:
            return {"value": 1.0, "detail": "리스트 항목 없음"}
        error_rate = len(issues) / total_list_lines
        score = max(0, 1.0 - error_rate)
        detail = f"{len(issues)} issues / {total_list_lines} list lines"
        if issues:
            detail += f" (첫 3개: {'; '.join(issues[:3])})"
        return {"value": round(score, 3), "detail": detail}
```

### Restraint
- **타입**: 정성
- **배점**: 5
- **하드 게이트**: 없음
- **설명**: raw에 없는 내용(hallucination, 과도한 추론)이 억제되었는지

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–1 | raw에 없는 주장 3건+ | 근거 없는 일반화 다수 |
| 2 | raw에 없는 주장 1~2건 | 과도한 일반화 1건 |
| 3 | 범위 약간 넘는 추론이 있으나 명시됨 | "~로 추정된다" 표현 사용 |
| 4 | raw 기반만 존재 | 추론 시 명시적 구분 |
| 5 | 엄격하게 raw 내용만 | 불확실한 내용 없음 |
