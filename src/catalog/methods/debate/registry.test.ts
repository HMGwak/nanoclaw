import { describe, expect, it } from 'vitest';

import {
  buildDebateServiceOverlay,
  getDebateModeSpec,
  getDebateProtocolSpec,
  listDebateModeSpecs,
  listDebateProtocolSpecs,
  parseDebateIntent,
  resolveDebateContracts,
} from './index.js';

describe('debate mode registry', () => {
  it('loads all seven debate modes', () => {
    const specs = listDebateModeSpecs();
    const ids = specs.map((spec) => spec.id).sort();

    expect(ids).toEqual([
      'advocate',
      'brainstorm',
      'delphi',
      'oxford',
      'socratic',
      'standard',
      'tradeoff',
    ]);
    expect(
      specs.every((spec) => spec.sourceModuleIds?.includes('quorum_cli')),
    ).toBe(true);
  });

  it('loads protocol specs and defaults consensus to lead_final_judgment', () => {
    const protocols = listDebateProtocolSpecs();
    expect(protocols).toHaveLength(7);

    const standardProtocol = getDebateProtocolSpec('standard');
    expect(standardProtocol?.consensusPolicy).toBe('lead_final_judgment');
    expect(standardProtocol?.sourceModuleIds).toContain('autoresearch');

    const standardMode = getDebateModeSpec('standard');
    expect(standardMode?.protocolId).toBe('standard');
  });

  it('parses natural-language debate intent and mode/round hints', () => {
    expect(
      parseDebateIntent('둘이 트럼프와 이란에 대해 5라운드 토론해봐'),
    ).toMatchObject({
      isDebateIntent: true,
      modeHint: 'standard',
      roundsHint: 5,
    });
    expect(
      parseDebateIntent('Oxford debate on monolith vs microservice'),
    ).toMatchObject({
      isDebateIntent: true,
      modeHint: 'oxford',
    });
    expect(parseDebateIntent('오늘 날씨 알려줘')).toMatchObject({
      isDebateIntent: false,
      topic: null,
    });
  });

  it('resolves canonical contracts and service overlay shape', () => {
    const contracts = resolveDebateContracts('tradeoff');
    expect(contracts.input.modeHint).toBe('tradeoff');
    expect(Array.isArray(contracts.input.evidencePacks)).toBe(true);
    expect(Array.isArray(contracts.output.roundSummaries)).toBe(true);

    const overlay = buildDebateServiceOverlay(
      ['discord_workshop_teamlead', 'discord_workshop_kimi'],
      {
        discord_workshop_teamlead: 'adjudicator',
        discord_workshop_kimi: 'opposer',
      },
      4,
      ['context://dept/workshop/background'],
    );
    expect(overlay.roundOverride).toBe(4);
    expect(overlay.backgroundKnowledgeRefs).toHaveLength(1);
  });
});
