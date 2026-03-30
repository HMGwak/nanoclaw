import { describe, expect, it, vi } from 'vitest';

import {
  handleDiscordWorkflowCancel,
  handleDiscordWorkflowResult,
  handleDiscordWorkflowStart,
} from './index.js';

describe('discord workflow service handlers', () => {
  it('allows planning groups to start workflows', () => {
    const onWorkflowRequested = vi.fn();

    const result = handleDiscordWorkflowStart(
      {
        title: '새 파이프라인',
        flowId: 'karpathy-loop',
        chatJid: 'dc:1234:planning',
        steps: [{ assignee: 'discord_workshop', goal: '구현' }],
      },
      'discord_planning',
      false,
      { onWorkflowRequested },
    );

    expect(result).toEqual({
      ok: true,
      flowId: 'karpathy-loop',
      stepCount: 1,
      chatJid: 'dc:1234:planning',
    });
    expect(onWorkflowRequested).toHaveBeenCalledWith(
      '새 파이프라인',
      [
        {
          step_index: 0,
          assignee: 'discord_workshop_teamlead',
          goal: '구현',
          acceptance_criteria: undefined,
          constraints: undefined,
          stage_id: 'baseline',
        },
      ],
      'karpathy-loop',
      'discord_planning',
      'dc:1234:planning',
    );
  });

  it('normalizes legacy flow ids to karpathy-loop', () => {
    const onWorkflowRequested = vi.fn();

    const result = handleDiscordWorkflowStart(
      {
        title: '레거시 호환',
        flowId: 'planning-workshop',
        chatJid: 'dc:1234:planning',
        steps: [{ assignee: 'discord_workshop', goal: '구현' }],
      },
      'discord_planning',
      false,
      { onWorkflowRequested },
    );

    expect(result).toEqual({
      ok: true,
      flowId: 'karpathy-loop',
      stepCount: 1,
      chatJid: 'dc:1234:planning',
    });
    expect(onWorkflowRequested).toHaveBeenCalledWith(
      '레거시 호환',
      [
        expect.objectContaining({
          stage_id: 'baseline',
        }),
      ],
      'karpathy-loop',
      'discord_planning',
      'dc:1234:planning',
    );
  });

  it('defaults missing flow id to karpathy-loop', () => {
    const onWorkflowRequested = vi.fn();

    const result = handleDiscordWorkflowStart(
      {
        title: '기본 플로우',
        chatJid: 'dc:1234:planning',
        steps: [{ assignee: 'discord_workshop', goal: '구현' }],
      },
      'discord_planning',
      false,
      { onWorkflowRequested },
    );

    expect(result).toEqual({
      ok: true,
      flowId: 'karpathy-loop',
      stepCount: 1,
      chatJid: 'dc:1234:planning',
    });
    expect(onWorkflowRequested).toHaveBeenCalledWith(
      '기본 플로우',
      [
        expect.objectContaining({
          stage_id: 'baseline',
        }),
      ],
      'karpathy-loop',
      'discord_planning',
      'dc:1234:planning',
    );
  });

  it('blocks non-planning groups from starting workflows', () => {
    const onWorkflowRequested = vi.fn();

    const result = handleDiscordWorkflowStart(
      {
        title: '차단 테스트',
        chatJid: 'dc:5678:workshop',
        steps: [{ assignee: 'discord_workshop', goal: '구현' }],
      },
      'discord_workshop',
      false,
      { onWorkflowRequested },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      error: 'Group "discord_workshop" is not allowed to start workflows',
    });
    expect(onWorkflowRequested).not.toHaveBeenCalled();
  });

  it('fails when chatJid is missing', () => {
    const onWorkflowRequested = vi.fn();

    const result = handleDiscordWorkflowStart(
      {
        title: 'missing chat jid',
        steps: [{ assignee: 'discord_workshop', goal: '구현' }],
      },
      'discord_planning',
      false,
      { onWorkflowRequested },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'missing_chat_jid',
      error: 'chatJid is required for workflow routing',
    });
    expect(onWorkflowRequested).not.toHaveBeenCalled();
  });

  it('fails when a step has empty assignee/goal', () => {
    const onWorkflowRequested = vi.fn();

    const result = handleDiscordWorkflowStart(
      {
        title: 'invalid steps',
        flowId: 'karpathy-loop',
        chatJid: 'dc:1234:planning',
        steps: [{ assignee: '', goal: '' }],
      },
      'discord_planning',
      false,
      { onWorkflowRequested },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'invalid_steps',
      error: 'steps[0] must include non-empty assignee and goal',
    });
    expect(onWorkflowRequested).not.toHaveBeenCalled();
  });

  it('fails when any step is malformed instead of silently dropping it', () => {
    const onWorkflowRequested = vi.fn();

    const result = handleDiscordWorkflowStart(
      {
        title: 'mixed steps',
        flowId: 'karpathy-loop',
        chatJid: 'dc:1234:planning',
        steps: [
          { assignee: 'discord_workshop', goal: '유효 step' },
          { assignee: '', goal: '' },
        ],
      },
      'discord_planning',
      false,
      { onWorkflowRequested },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'invalid_steps',
      error: 'steps[1] must include non-empty assignee and goal',
    });
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
