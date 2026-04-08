# Rubric: Wiki Automation (v2 — Fidelity-Centered)

## 설정
- keep_threshold: 80
- discard_threshold: 60
- max_iterations: 4
- convergence_delta: 1

## 평가 항목

### Fact Completeness
- **타입**: 정성
- **배점**: 35
- **하드 게이트**: 없음
- **설명**: Evaluate whether key facts from raw documents are fully and accurately reflected in the wiki. Assess both breadth (recall) and critical omissions.

#### 채점 앵커
| Score | Criteria | Example |
|-------|----------|---------|
| 0–7 | Most key facts missing or severely distorted | Only 2 out of 10+ extractable key facts reflected |
| 8–14 | Some key facts reflected, significant omissions remain | 30–50% coverage, 1+ critical decision omitted |
| 15–21 | Most key facts reflected, minor detail gaps | 50–70% coverage, date/number details missing |
| 22–28 | Key facts faithfully reflected, only trivial omissions | 70–90% coverage, no critical omissions |
| 29–35 | Key + supporting facts fully reflected | 90%+ coverage, all key facts accurately captured |

### Citation Accuracy
- **타입**: 정량
- **배점**: 20
- **하드 게이트**: 0.8
- **설명**: Ratio of factual sentences with proper footnote citations ([^...]) referencing the source raw document. Citations must point to the correct source.

#### 측정 방법
```python
import re
def measure(output_files, reference_files):
    for f in output_files:
        text = f.read_text()
        sentences = [s.strip() for s in re.split(r'[.?!]\s', text) if s.strip()]
        sentences = [s for s in sentences if not s.startswith('#') and not s.startswith('---')]
        if not sentences:
            return {"value": 0.0, "detail": "No factual sentences found"}
        cited = sum(1 for s in sentences if re.search(r'\[\^[^\]]+\]', s))
        ratio = cited / len(sentences)
        return {"value": round(ratio, 3), "detail": f"{cited}/{len(sentences)} sentences cited"}
```

### Structural Readability
- **타입**: 정성
- **배점**: 25
- **하드 게이트**: 없음
- **설명**: Evaluate whether a new team member can locate desired information within 30 seconds. Assess information hierarchy (headings, bullet points, tables), scannability, and visual structure.

#### 채점 앵커
| Score | Criteria | Example |
|-------|----------|---------|
| 0–5 | No structure, wall of text | No headings, prose-only content |
| 6–10 | Basic headings present but hierarchy unclear | Headings exist but content misplaced across sections |
| 11–15 | Hierarchy present with bullet points, some inconsistency | Mostly structured but some sections remain as prose |
| 16–20 | Consistent hierarchy, active use of tables/bullets | All sections scannable, information easy to locate |
| 21–25 | Perfect information layering with checklists/tables | Target info reachable in 30 seconds, visually excellent |

### Restraint
- **타입**: 정성
- **배점**: 10
- **하드 게이트**: 없음
- **설명**: Evaluate whether the wiki strictly stays within raw document content. No hallucination, excessive inference, or filler text that reduces information density.

#### 채점 앵커
| Score | Criteria | Example |
|-------|----------|---------|
| 0–2 | 3+ unsupported claims from raw | Multiple baseless generalizations |
| 3–4 | 1–2 unsupported claims | One excessive generalization |
| 5–6 | Minor extrapolation, explicitly marked | Uses "presumably" or "estimated" phrasing |
| 7–8 | Only raw-based content | Clear distinction when inference is made |
| 9–10 | Strictly raw content only, high density | No uncertain content, no unnecessary filler |

### Actionability
- **타입**: 정성
- **배점**: 10
- **하드 게이트**: 없음
- **설명**: Evaluate whether a new team member can perform the task using only this wiki note. Clear procedures, required documents, deadlines, and exception handling.

#### 채점 앵커
| Score | Criteria | Example |
|-------|----------|---------|
| 0–2 | Abstract description only, no procedures | "Prepare documents" — no list, form, or deadline |
| 3–4 | Some procedures but not executable | Document list exists but how-to is missing |
| 5–6 | Main procedures present, exceptions lacking | Normal case only, no rejection/error handling |
| 7–8 | Procedures, criteria, and branching mostly covered | Normal + exception, deadlines, responsible teams noted |
| 9–10 | Complete guide | New member can execute immediately, checklist included |
