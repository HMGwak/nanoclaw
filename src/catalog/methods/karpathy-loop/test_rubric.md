## 설정

- keep_threshold: 90.0
- discard_threshold: 20.0
- max_iterations: 10
- convergence_delta: 1.0
- task_timeout_seconds: 30
- measure_timeout_seconds: 5

## 평가 항목

### Random Value

- **타입**: 정량
- **배점**: 100.0
- **하드 게이트**: 없음
- **설명**: 랜덤 값이 0.9 이상이면 통과

#### 측정 방법

```python
def measure(output_files, reference_files):
    value = float(Path(output_files[0]).read_text().strip())
    return {"value": value, "detail": f"random value: {value:.4f}"}
```
