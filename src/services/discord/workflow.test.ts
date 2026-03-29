import { describe, expect, it, vi } from 'vitest';

import {
  handleDiscordWorkflowCancel,
  handleDiscordWorkflowResult,
  handleDiscordWorkflowStart,
} from './index.js';

describe('discord workflow service handlers', () => {
  it('allows planning groups to start workflows', () => {
    const onWorkflowRequested = vi.fn();

    handleDiscordWorkflowStart(
      {
        title: '새 파이프라인',
        flowId: 'planning-workshop',
        chatJid: 'dc:1234:planning',
        steps: [{ assignee: 'discord_workshop', goal: '구현' }],
      },
      'discord_planning',
      false,
      { onWorkflowRequested },
    );

    expect(onWorkflowRequested).toHaveBeenCalledWith(
      '새 파이프라인',
      [
        {
          step_index: 0,
          assignee: 'discord_workshop_teamlead',
          goal: '구현',
          acceptance_criteria: undefined,
          constraints: undefined,
          stage_id: 'execute',
        },
      ],
      'planning-workshop',
      'discord_planning',
      'dc:1234:planning',
    );
  });

  it('blocks non-planning groups from starting workflows', () => {
    const onWorkflowRequested = vi.fn();

    handleDiscordWorkflowStart(
      {
        title: '차단 테스트',
        chatJid: 'dc:5678:workshop',
        steps: [{ assignee: 'discord_workshop', goal: '구현' }],
      },
      'discord_workshop',
      false,
      { onWorkflowRequested },
    );

    expect(onWorkflowRequested).not.toHaveBeenCalled();
  });

  it('forwards workflow result and cancel events', () => {
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
