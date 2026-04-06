export function formatAgentFailureNotice(error?: string | null): string {
  if (error?.includes('timed out')) {
    return '요청을 처리하는 중 응답 시간이 초과되었습니다. 질문을 조금 더 짧게 나누어 다시 보내 주세요.';
  }

  return '요청을 처리하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
}
