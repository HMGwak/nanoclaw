"""
M365 Graph API PoC 테스트 스크립트.
Step 0: 인증 + API 동작 검증 (Microsoft Todo + Outlook Calendar)

실행:
    cd /Users/planee/Automation/nanoclaw
    .venv/bin/python3 src/catalog/tasks/schedule_sync/poc_test.py
"""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import requests

# msgraph_auth 임포트 (같은 패키지 내)
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))
from src.catalog.tasks.schedule_sync.msgraph_auth import GraphAuth, CONFIG_PATH


def check(label: str, ok: bool, detail: str = ""):
    mark = "✅" if ok else "❌"
    print(f"  {mark} {label}" + (f" — {detail}" if detail else ""))
    return ok


def test_me(auth: GraphAuth) -> bool:
    print("\n[1] 사용자 정보 확인")
    r = requests.get(f"{auth.get_base_url()}/me", headers=auth.get_headers())
    if r.status_code == 200:
        data = r.json()
        return check("GET /me", True, f"{data.get('displayName')} <{data.get('mail') or data.get('userPrincipalName')}>")
    return check("GET /me", False, f"HTTP {r.status_code}: {r.text[:100]}")


def test_todo(auth: GraphAuth) -> bool:
    print("\n[2] Microsoft Todo API")
    base = auth.get_base_url()
    headers = auth.get_headers()
    all_ok = True

    # GET lists
    r = requests.get(f"{base}/me/todo/lists", headers=headers)
    all_ok &= check("GET /me/todo/lists", r.status_code == 200, f"HTTP {r.status_code}")
    if r.status_code != 200:
        print(f"     응답: {r.text[:200]}")
        return False

    lists = r.json().get("value", [])
    check("기존 리스트 수", True, f"{len(lists)}개")

    # POST 테스트 리스트 생성
    test_list_name = "_NanoClaw_PoC_Test_"
    r = requests.post(
        f"{base}/me/todo/lists",
        headers=headers,
        json={"displayName": test_list_name},
    )
    all_ok &= check("POST /me/todo/lists (생성)", r.status_code == 201, f"HTTP {r.status_code}")
    if r.status_code != 201:
        print(f"     응답: {r.text[:200]}")
        return False

    list_id = r.json()["id"]

    # POST 태스크 생성
    due = (date.today() + timedelta(days=7)).isoformat() + "T00:00:00.0000000"
    r = requests.post(
        f"{base}/me/todo/lists/{list_id}/tasks",
        headers=headers,
        json={
            "title": "NanoClaw PoC 테스트 태스크",
            "dueDateTime": {"dateTime": due, "timeZone": "Asia/Seoul"},
        },
    )
    all_ok &= check("POST .../tasks (태스크 생성)", r.status_code == 201, f"HTTP {r.status_code}")
    task_id = r.json().get("id") if r.status_code == 201 else None

    # PATCH 완료 처리
    if task_id:
        r = requests.patch(
            f"{base}/me/todo/lists/{list_id}/tasks/{task_id}",
            headers=headers,
            json={"status": "completed"},
        )
        all_ok &= check("PATCH .../tasks (완료 처리)", r.status_code == 200, f"HTTP {r.status_code}")

    # DELETE 정리
    r = requests.delete(f"{base}/me/todo/lists/{list_id}", headers=headers)
    check("DELETE 테스트 리스트 정리", r.status_code == 204, f"HTTP {r.status_code}")

    return all_ok


def test_calendar(auth: GraphAuth) -> bool:
    print("\n[3] Outlook Calendar API")
    base = auth.get_base_url()
    headers = auth.get_headers()
    all_ok = True

    # GET calendars
    r = requests.get(f"{base}/me/calendars", headers=headers)
    all_ok &= check("GET /me/calendars", r.status_code == 200, f"HTTP {r.status_code}")
    if r.status_code != 200:
        print(f"     응답: {r.text[:200]}")
        return False

    cals = r.json().get("value", [])
    check("기존 캘린더 수", True, f"{len(cals)}개")
    default_cal = next((c for c in cals if c.get("isDefaultCalendar")), cals[0] if cals else None)
    if default_cal:
        check("기본 캘린더", True, default_cal.get("name", "?"))

    # POST 테스트 이벤트 (종일 이벤트)
    today = date.today()
    r = requests.post(
        f"{base}/me/events",
        headers=headers,
        json={
            "subject": "[NanoClaw PoC Test] 마감일 이벤트",
            "start": {"dateTime": today.isoformat(), "timeZone": "Asia/Seoul"},
            "end": {"dateTime": (today + timedelta(days=1)).isoformat(), "timeZone": "Asia/Seoul"},
            "isAllDay": True,
            "body": {"contentType": "text", "content": "NanoClaw schedule sync PoC test event"},
        },
    )
    all_ok &= check("POST /me/events (이벤트 생성)", r.status_code == 201, f"HTTP {r.status_code}")
    if r.status_code != 201:
        print(f"     응답: {r.text[:200]}")
        return False

    event_id = r.json()["id"]

    # DELETE 정리
    r = requests.delete(f"{base}/me/events/{event_id}", headers=headers)
    check("DELETE 테스트 이벤트 정리", r.status_code == 204, f"HTTP {r.status_code}")

    return all_ok


def main():
    print("=" * 60)
    print("NanoClaw M365 Graph API PoC 테스트")
    print("=" * 60)

    # 설정 파일 확인
    if not CONFIG_PATH.exists():
        print(f"\n❌ 설정 파일 없음: {CONFIG_PATH}")
        print("\n다음 내용으로 파일을 생성하세요:")
        print(f'  mkdir -p {CONFIG_PATH.parent}')
        print(f'  cat > {CONFIG_PATH} << EOF')
        print('  {')
        print('    "client_id": "Azure Portal의 Application (client) ID",')
        print('    "tenant_id": "Azure Portal의 Directory (tenant) ID"')
        print('  }')
        print('  EOF')
        sys.exit(1)

    try:
        auth = GraphAuth.from_config()
        print("\n토큰 획득 중...")
        auth.get_token()  # Device Code Flow 트리거 (필요 시)
        print("✅ 인증 성공\n")
    except Exception as e:
        print(f"\n❌ 인증 실패: {e}")
        sys.exit(1)

    results = {
        "me": test_me(auth),
        "todo": test_todo(auth),
        "calendar": test_calendar(auth),
    }

    print("\n" + "=" * 60)
    print("결과 요약")
    print("=" * 60)
    all_pass = all(results.values())
    for name, ok in results.items():
        print(f"  {'✅' if ok else '❌'} {name}")

    if all_pass:
        print("\n✅ 모든 API 테스트 통과 — Step 0 완료")
        # 결과 저장
        result_path = Path(__file__).parent / "step0_poc_result.json"
        result_path.write_text(json.dumps({"status": "pass", "tests": results}, indent=2))
        print(f"   결과 저장: {result_path}")
    else:
        print("\n⚠️  일부 테스트 실패 — 위 오류 메시지 확인")
        sys.exit(1)


if __name__ == "__main__":
    main()
