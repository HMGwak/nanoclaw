import { describe, expect, it } from 'vitest';

import {
  canStartWorkflowFromGroup,
  resolveGroupLeadSender,
  resolveGroupPersonaBotLabel,
  resolveGroupPersonaMode,
  resolveGroupTargetSender,
  resolveServiceDeployment,
  shouldEnforceSingleSender,
} from './index.js';
import type { RegisteredGroup } from '../types.js';

describe('service deployment resolution', () => {
  const workshopGroup: RegisteredGroup = {
    name: '작업실',
    folder: 'discord_workshop',
    trigger: '@작업실',
    added_at: '2026-01-01T00:00:00Z',
  };

  it('resolves the workshop deployment from the catalog', () => {
    const deployment = resolveServiceDeployment(workshopGroup);

    expect(deployment?.service).toBe('discord');
    expect(deployment?.departmentId).toBe('workshop');
    expect(deployment?.department.displayName).toBe('작업실');
    expect(deployment?.lead?.displayName).toBe('작업실 팀장');
    expect(deployment?.lead?.capabilityPrompt).toContain(
      'operating as a planner',
    );
    expect(deployment?.leadPrompt).toContain('작업실 팀장');
    expect(deployment?.leadPrompt).toContain('pragmatic and direct');
    expect(deployment?.departmentPrompt).toContain(
      'Discord Workshop Department',
    );
    expect(deployment?.personnel.map((agent) => agent.displayName)).toEqual([
      '작업실 팀장',
    ]);
    expect(deployment?.teammates.map((agent) => agent.displayName)).toEqual([]);
    expect(deployment?.senderBotMap).toEqual({
      '작업실 팀장': 'workshop',
    });
    expect(deployment?.botLabel).toBe('workshop');
    expect(deployment?.canonicalGroupFolder).toBe('discord_workshop_teamlead');
    expect(deployment?.responsePolicy).toBe('always');
    expect(deployment?.requiresTrigger).toBe(false);
  });

  it('resolves persona settings from the deployment rather than group config', () => {
    expect(resolveGroupLeadSender(workshopGroup)).toBe('작업실 팀장');
    expect(resolveGroupPersonaMode(workshopGroup)).toBe('bot_only');
    expect(resolveGroupPersonaBotLabel(workshopGroup, '작업실 팀장')).toBe(
      'workshop',
    );
    expect(
      resolveGroupTargetSender(
        workshopGroup,
        'dc:1487329723443839109:workshop',
      ),
    ).toBe('작업실 팀장');
    expect(
      resolveGroupTargetSender(workshopGroup, 'dc:1487329723443839109:kimi'),
    ).toBe('작업실 팀장');
    expect(shouldEnforceSingleSender(workshopGroup)).toBe(true);

    const kimiGroup: RegisteredGroup = {
      name: '작업실-키미',
      folder: 'discord_workshop_kimi',
      trigger: '@키미',
      added_at: '2026-01-01T00:00:00Z',
    };
    expect(resolveGroupLeadSender(kimiGroup)).toBe('키미');
    expect(resolveGroupPersonaBotLabel(kimiGroup, '키미')).toBe('kimi');
    expect(
      resolveGroupTargetSender(kimiGroup, 'dc:1487329723443839109:kimi'),
    ).toBe('키미');
    expect(shouldEnforceSingleSender(kimiGroup)).toBe(true);
  });

  it('ignores legacy service fields in containerConfig as the source of truth', () => {
    const overriddenGroup: RegisteredGroup = {
      ...workshopGroup,
      containerConfig: {
        leadSender: '가짜 팀장',
        senderBotMap: { 가짜: 'fake' },
        personaMode: 'hybrid',
        subAgents: [
          {
            name: '가짜 팀원',
            backend: 'openai',
            model: 'fake-model',
          },
        ],
      },
    };

    const deployment = resolveServiceDeployment(overriddenGroup);

    expect(deployment?.lead?.displayName).toBe('작업실 팀장');
    expect(deployment?.teammates.map((agent) => agent.displayName)).toEqual([]);
    expect(resolveGroupLeadSender(overriddenGroup)).toBe('작업실 팀장');
    expect(resolveGroupPersonaMode(overriddenGroup)).toBe('bot_only');
    expect(resolveGroupPersonaBotLabel(overriddenGroup, '작업실 팀장')).toBe(
      'workshop',
    );
  });

  it('resolves service-owned persona prompts for all discord departments', () => {
    const planningDeployment = resolveServiceDeployment({
      name: '기획실',
      folder: 'discord_planning',
      trigger: '@기획실',
      added_at: '2026-01-01T00:00:00Z',
    });
    const secretaryDeployment = resolveServiceDeployment({
      name: '비서실',
      folder: 'discord_secretary',
      trigger: '@비서실',
      added_at: '2026-01-01T00:00:00Z',
    });

    expect(planningDeployment?.leadPrompt).toContain('기획실');
    expect(planningDeployment?.leadPrompt).toContain(
      'skeptical of fuzzy requirements',
    );
    expect(planningDeployment?.departmentPrompt).toContain(
      'Discord Planning Department',
    );
    expect(secretaryDeployment?.leadPrompt).toContain('비서실');
    expect(secretaryDeployment?.leadPrompt).toContain('concise and composed');
    expect(secretaryDeployment?.departmentPrompt).toContain(
      'Discord Secretary Department',
    );
    expect(secretaryDeployment?.department.handoffTemplate).toContain(
      'Department Handoff Template',
    );
  });

  it('uses deployment-level workflow start authorization', () => {
    expect(canStartWorkflowFromGroup('discord_planning', false)).toBe(true);
    expect(canStartWorkflowFromGroup('discord_planning_bot', false)).toBe(true);
    expect(canStartWorkflowFromGroup('discord_workshop', false)).toBe(false);
    expect(canStartWorkflowFromGroup('discord_workshop_teamlead', false)).toBe(
      false,
    );
    expect(canStartWorkflowFromGroup('any-group', true)).toBe(true);
  });
});
