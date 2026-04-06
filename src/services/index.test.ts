import { describe, expect, it } from 'vitest';

import {
  canStartWorkflowFromGroup,
  resolveGroupLeadSender,
  resolveGroupImportedSubAgents,
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
    expect(deployment?.lead?.toolsetIds).toContain('global_browser_research');
    expect(deployment?.lead?.browserPolicy?.id).toBe('browser_stack_v1');
    expect(deployment?.lead?.browserPolicy?.enforcement).toBe('hard');
    expect(deployment?.departmentPrompt).toContain(
      'Discord Workshop Department',
    );
    expect(deployment?.personnel.map((agent) => agent.displayName)).toEqual([
      '작업실 팀장',
      '키미',
    ]);
    expect(deployment?.teammates.map((agent) => agent.displayName)).toEqual([
      '키미',
    ]);
    expect(deployment?.senderBotMap).toEqual({
      '작업실 팀장': 'workshop',
      키미: 'kimi',
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
    ).toBe('키미');
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
    expect(deployment?.teammates.map((agent) => agent.displayName)).toEqual([
      '키미',
    ]);
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
    expect(planningDeployment?.lead?.toolsetIds).toContain(
      'global_browser_research',
    );
    expect(planningDeployment?.leadPrompt).toContain(
      'planning-led debate coordinator',
    );
    expect(planningDeployment?.leadPrompt).toContain('run_debate');
    expect(planningDeployment?.departmentPrompt).toContain(
      'Discord Planning Department',
    );
    expect(planningDeployment?.departmentPrompt).toContain('run_debate');
    expect(secretaryDeployment?.leadPrompt).toContain('비서실');
    expect(secretaryDeployment?.leadPrompt).toContain('concise and composed');
    expect(secretaryDeployment?.lead?.toolsetIds).toContain(
      'global_browser_research',
    );
    expect(secretaryDeployment?.containerRuntime.skillIds).toEqual(
      expect.arrayContaining([
        'agent-browser',
        'obsidian-markdown',
        'obsidian-bases',
        'obsidian-canvas',
      ]),
    );
    expect(secretaryDeployment?.containerRuntime.additionalMounts).toEqual([
      {
        hostPath: '/Users/planee/Documents/Mywork',
        containerPath: 'obsidian-vault',
        readonly: false,
      },
    ]);
    expect(secretaryDeployment?.departmentPrompt).toContain(
      'Discord Secretary Department',
    );
    expect(secretaryDeployment?.department.handoffTemplate).toContain(
      'Department Handoff Template',
    );
  });

  it('disables workflow start authorization for discord after the debate-first refactor', () => {
    expect(canStartWorkflowFromGroup('discord_planning')).toBe(false);
    expect(canStartWorkflowFromGroup('discord_planning_bot')).toBe(false);
    expect(canStartWorkflowFromGroup('discord_workshop')).toBe(false);
    expect(canStartWorkflowFromGroup('discord_workshop_teamlead')).toBe(false);
    expect(canStartWorkflowFromGroup('discord_secretary')).toBe(false);
    expect(canStartWorkflowFromGroup('any-group')).toBe(false);
  });

  it('imports hidden debate sub-agents for planning without changing visible speakers', () => {
    const planningGroup: RegisteredGroup = {
      name: '기획실',
      folder: 'discord_planning',
      trigger: '@기획실',
      added_at: '2026-01-01T00:00:00Z',
    };

    const imported = resolveGroupImportedSubAgents(planningGroup);
    expect(imported.map((agent) => agent.name)).toEqual([
      '기획실 판정관',
      '작업실 팀장',
      '키미',
    ]);
    expect(imported[0]?.systemPrompt).toContain(
      'internal member of the Discord 기획실 department',
    );
    expect(imported[1]?.systemPrompt).toContain(
      'internal member of the Discord 작업실 department',
    );
    expect(imported[2]?.systemPrompt).toContain(
      'internal member of the Discord 작업실 department',
    );
    expect(imported[1]?.systemPrompt).not.toContain(
      '## Workshop Collaboration',
    );
  });

  it('injects browser policy required tools into legacy group allowlist overrides', () => {
    const overriddenGroup: RegisteredGroup = {
      name: '작업실',
      folder: 'discord_workshop',
      trigger: '@작업실',
      added_at: '2026-01-01T00:00:00Z',
      containerConfig: {
        allowedTools: ['shell', 'web_search', 'web_fetch'],
      },
    };

    const deployment = resolveServiceDeployment(overriddenGroup);
    expect(deployment?.containerRuntime.allowedTools).toEqual(
      expect.arrayContaining([
        'shell',
        'web_search',
        'web_fetch',
        'cloudflare_fetch',
        'browse_open',
        'playwright_open',
      ]),
    );
  });

  it('keeps the main group from inheriting secretary vault mounts by alias', () => {
    const deployment = resolveServiceDeployment({
      name: '메인',
      folder: 'main',
      trigger: '@메인',
      added_at: '2026-01-01T00:00:00Z',
      isMain: true,
    });

    expect(deployment?.departmentId).toBe('secretary');
    expect(deployment?.containerRuntime.additionalMounts).toBeUndefined();
  });
});
