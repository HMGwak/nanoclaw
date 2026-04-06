# Rubric: 정기제출 Wiki Note

## 설정
- keep_threshold: 85
- discard_threshold: 60
- max_iterations: 3
- convergence_delta: 3

## 문서 구조
- ## 업무 개요
- ## 국가별 제출 일정 및 현황
- ## 정기제출 절차
- ## 필수 서류 및 자료
- ## 제품리스트 관리 기준
- ## 이슈사항 유형별 정리
- ## 신규 담당자 체크리스트
- ## 열린 이슈

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
- **설명**: 정기제출 절차/단계가 명시된 섹션 수

#### 측정 방법
```python
import re
def measure(output_files, reference_files):
    STEP_KEYWORDS = ["접수", "요청", "제출", "송부", "확인", "절차", "국가", "일정", "제품", "리스트", "서류"]
    for f in output_files:
        text = f.read_text()
        headings = re.findall(r'^#{1,3}\s+(.+)$', text, re.MULTILINE)
        count = sum(1 for h in headings if any(kw in h for kw in STEP_KEYWORDS))
        return {"value": count, "detail": f"절차 관련 섹션 {count}개"}
```

### Coverage
- **타입**: 정성
- **배점**: 25
- **하드 게이트**: 없음
- **설명**: 정기제출의 핵심 측면(국가별 일정, 절차, 필수 서류, 제품리스트 관리, 이슈)을 얼마나 포괄하는지

#### 채점 앵커
| 점수 구간 | 기준 |
|-----------|------|
| 0–5 | 주제의 한 측면만 언급 |
| 6–10 | 2~3개 측면만 |
| 11–15 | 핵심 측면 대부분, 깊이 불균일 |
| 16–20 | 모든 핵심 측면, 깊이 균일 |
| 21–25 | 핵심 + 국가별 예외/일정 차이까지 |

### Grounding Accuracy
- **타입**: 정성
- **배점**: 25
- **하드 게이트**: 없음
- **설명**: wiki note의 주장이 raw 문서와 실제로 일치하는지

#### 채점 앵커
| 점수 구간 | 기준 |
|-----------|------|
| 0–5 | 각주가 있으나 내용 불일치 다수 |
| 6–10 | 주요 주장은 일치하나 세부 불일치 |
| 11–15 | 대부분 일치, 1~2건 미세 차이 |
| 16–20 | 모든 핵심 주장이 raw와 정확히 일치 |
| 21–25 | 정확한 일치 + raw의 조건/뉘앙스 보존 |

### Actionability
- **타입**: 정성
- **배점**: 20
- **하드 게이트**: 없음
- **설명**: 신규 담당자가 이 wiki note만 보고 정기제출 업무를 수행할 수 있는지

#### 채점 앵커
| 점수 구간 | 기준 |
|-----------|------|
| 0–4 | 추상적 설명만, 절차 없음 |
| 5–8 | 절차 일부 있으나 실행 불가 |
| 9–12 | 주요 절차 있으나 예외 미흡 |
| 13–16 | 절차·기준·분기 대부분 갖춤 |
| 17–20 | 완전한 가이드, 즉시 수행 가능 |

### Restraint
- **타입**: 정성
- **배점**: 10
- **하드 게이트**: 없음
- **설명**: raw에 없는 내용이 억제되었는지

#### 채점 앵커
| 점수 구간 | 기준 |
|-----------|------|
| 0–2 | raw에 없는 주장 3건+ |
| 3–4 | raw에 없는 주장 1~2건 |
| 5–6 | 범위 약간 넘는 추론이 있으나 명시됨 |
| 7–8 | raw 기반만 존재 |
| 9–10 | 엄격하게 raw 내용만 |
