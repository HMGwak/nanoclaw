import { describe, expect, it, vi } from 'vitest';

import {
  handleDiscordWorkflowCancel,
  handleDiscordWorkflowResult,
  handleDiscordWorkflowStart,
} from './index.js';

describe('discord workflow service handlers', () => {
  it('blocks workflow starts for planning after the debate-first refactor', () => {
    const onWorkflowRequested = vi.fn();

    const result = handleDiscordWorkflowStart(
      {
        title: '새 파이프라인',
        chatJid: 'dc:1234:planning',
        steps: [
          {
            assignee: 'discord_workshop',
            goal: '구현',
            acceptance_criteria: ['테스트 통과'],
            constraints: ['기존 API 호환 유지'],
            stage_id: 'change',
          },
        ],
      },
      'discord_planning',
      false,
      { onWorkflowRequested },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      error: 'Group "discord_planning" is not allowed to start workflows',
    });
    expect(onWorkflowRequested).not.toHaveBeenCalled();
  });

  it('still forwards workflow result and cancel events for preserved runtime paths', () => {
    const onWorkflowStepResult = vi.fn();
    const onWorkflowCancelled = vi.fn();

    handleDiscordWorkflowResult(
      {
        workflowId: 'wf-123',
        stepIndex: 0,
        status: 'completed',
        resultSummary: '완료',
      },
      { onWorkflowStepResult },
    );
    handleDiscordWorkflowCancel({ workflowId: 'wf-123' }, 'discord_planning', {
      onWorkflowCancelled,
    });

    expect(onWorkflowStepResult).toHaveBeenCalledWith(
      'wf-123',
      0,
      'completed',
      '완료',
    );
    expect(onWorkflowCancelled).toHaveBeenCalledWith(
      'wf-123',
      'discord_planning',
    );
  });
});
