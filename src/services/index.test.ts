import { describe, expect, it } from 'vitest';

import {
  canStartWorkflowFromGroup,
  resolveGroupLeadSender,
  resolveGroupPersonaBotLabel,
  resolveGroupPersonaMode,
  resolveServiceDeployment,
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
    expect(deployment?.lead?.displayName).toBe('작업실 팀장');
    expect(deployment?.teammates.map((agent) => agent.displayName)).toEqual([
      '키미',
    ]);
    expect(deployment?.senderBotMap).toEqual({
      '작업실 팀장': 'workshop',
      키미: 'kimi',
    });
  });

  it('resolves persona settings from the deployment rather than group config', () => {
    expect(resolveGroupLeadSender(workshopGroup)).toBe('작업실 팀장');
    expect(resolveGroupPersonaMode(workshopGroup)).toBe('bot_only');
    expect(resolveGroupPersonaBotLabel(workshopGroup, '키미')).toBe('kimi');
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
    expect(deployment?.teammates.map((agent) => agent.displayName)).toEqual([
      '키미',
    ]);
    expect(resolveGroupLeadSender(overriddenGroup)).toBe('작업실 팀장');
    expect(resolveGroupPersonaMode(overriddenGroup)).toBe('bot_only');
    expect(resolveGroupPersonaBotLabel(overriddenGroup, '키미')).toBe('kimi');
  });

  it('uses deployment-level workflow start authorization', () => {
    expect(canStartWorkflowFromGroup('discord_planning', false)).toBe(true);
    expect(canStartWorkflowFromGroup('discord_workshop', false)).toBe(false);
    expect(canStartWorkflowFromGroup('any-group', true)).toBe(true);
  });
});
