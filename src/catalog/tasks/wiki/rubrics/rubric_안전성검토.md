# Rubric: 안전성검토 Wiki Note

## 설정
- keep_threshold: 85
- discard_threshold: 60
- max_iterations: 3
- convergence_delta: 3

## 평가 항목

### Footnote Ratio
- **타입**: 정량
- **배점**: 20
- **하드 게이트**: 0.7
- **설명**: wiki note 본문의 서술 문장 중 raw 출처 각주([^...])가 달린 비율

#### 측정 방법
```python
import re
def measure(output_files, reference_files):
    for f in output_files:
        text = f.read_text()
        sentences = [s.strip() for s in re.split(r'[.?!]\s', text) if s.strip()]
        sentences = [s for s in sentences if not s.startswith('#') and not s.startswith('---')]
        if not sentences:
            return {"value": 0.0, "detail": "서술 문장 없음"}
        cited = sum(1 for s in sentences if re.search(r'\[\^[^\]]+\]', s))
        ratio = cited / len(sentences)
        return {"value": round(ratio, 3), "detail": f"{cited}/{len(sentences)} 문장에 각주"}
```

### Review Steps
- **타입**: 정량
- **배점**: 0
- **하드 게이트**: 3
- **설명**: 검토 절차/단계가 명시된 섹션 수 (접수, 자료확인, 검토, 판정, 후속조치 등)

#### 측정 방법
```python
import re
def measure(output_files, reference_files):
    STEP_KEYWORDS = ["접수", "요청", "자료", "수령", "검토", "판정", "보고서", "후속", "이슈", "결과", "조치", "확인", "절차"]
    for f in output_files:
        text = f.read_text()
        headings = re.findall(r'^#{1,3}\s+(.+)$', text, re.MULTILINE)
        count = sum(1 for h in headings if any(kw in h for kw in STEP_KEYWORDS))
        return {"value": count, "detail": f"절차 관련 섹션 {count}개"}
```

### Checklist Presence
- **타입**: 정량
- **배점**: 5
- **하드 게이트**: 없음
- **설명**: 담당자 확인용 체크리스트/절차 항목 수 (있으면 가점, 없어도 통과)

#### 측정 방법
```python
import re
def measure(output_files, reference_files):
    for f in output_files:
        text = f.read_text()
        checklists = re.findall(r'^-\s*\[[ x]\]\s+', text, re.MULTILINE)
        bullets = re.findall(r'^-\s+(?:확인|체크|검증|대조|점검)', text, re.MULTILINE)
        count = len(checklists) + len(bullets)
        score = min(count, 5)
        return {"value": score / 5, "detail": f"체크리스트/확인 항목 {count}개"}
```

### Coverage
- **타입**: 정성
- **배점**: 25
- **하드 게이트**: 없음
- **설명**: 안전성검토의 핵심 측면(요청 배경, 대상 자재, 검토 과정, 판정 결과, 후속 조치)을 얼마나 포괄하는지

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–5 | 주제의 한 측면만 언급 | 요청 정보만 있고 검토 과정/판정 없음 |
| 6–10 | 2~3개 측면만 | 요청+자재는 있으나 판정/후속 누락 |
| 11–15 | 핵심 측면 대부분, 깊이 불균일 | 판정까지 있으나 근거 부실 |
| 16–20 | 모든 핵심 측면, 깊이 균일 | 요청→자재→검토→판정→후속 전체 |
| 21–25 | 핵심 + 예외/리스크까지 | 자료 누락 대응, 재검토 분기 등 포함 |

### Grounding Accuracy
- **타입**: 정성
- **배점**: 25
- **하드 게이트**: 없음
- **설명**: wiki note의 주장이 raw 문서와 실제로 일치하는지. raw에 없는 추론이 섞이지 않았는지.

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–5 | 각주가 있으나 내용 불일치 다수 | 인용한 raw와 wiki 주장이 다른 경우 3건+ |
| 6–10 | 주요 주장은 일치하나 세부 불일치 | 날짜, 자재 코드 등이 다른 경우 |
| 11–15 | 대부분 일치, 1~2건 미세 차이 | 맥락 미세 왜곡 |
| 16–20 | 모든 핵심 주장이 raw와 정확히 일치 | 불일치 없음 |
| 21–25 | 정확한 일치 + raw의 조건/뉘앙스 보존 | 조건부 판정의 조건까지 반영 |

### Actionability
- **타입**: 정성
- **배점**: 20
- **하드 게이트**: 없음
- **설명**: 신규 담당자가 이 wiki note만 보고 동일 유형의 안전성검토 업무를 수행할 수 있는지

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–4 | 추상적 설명만, 절차 없음 | "검토를 한다" — 뭘 어떻게 하는지 없음 |
| 5–8 | 절차 일부 있으나 실행 불가 | 요청자료 목록은 있으나 확인법 누락 |
| 9–12 | 주요 절차 있으나 예외 미흡 | 정상 케이스만, 자료 누락 시 대응 없음 |
| 13–16 | 절차·기준·분기 대부분 갖춤 | 정상+예외, 판정 기준, 보고서 양식 명시 |
| 17–20 | 완전한 가이드 | 체크리스트+분기+템플릿, 즉시 수행 가능 |

### Restraint
- **타입**: 정성
- **배점**: 10
- **하드 게이트**: 없음
- **설명**: raw에 없는 내용(hallucination, 과도한 추론, 일반화)이 억제되었는지

#### 채점 앵커
| 점수 구간 | 기준 | 판정 예시 |
|-----------|------|----------|
| 0–2 | raw에 없는 주장 3건+ | 근거 없는 일반화, 추측 다수 |
| 3–4 | raw에 없는 주장 1~2건 | 과도한 일반화 1건 |
| 5–6 | 범위 약간 넘는 추론이 있으나 명시됨 | "~로 추정된다" 표현 사용 |
| 7–8 | raw 기반만 존재 | 사실과 해석 구분 명시 |
| 9–10 | 엄격하게 raw 내용만 | 편집 메모로 해석 분리, 불확실한 내용 없음 |
