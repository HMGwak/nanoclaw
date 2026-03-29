import { describe, expect, it } from 'vitest';

import {
  getDiscordCanonicalGroupFolderForFolder,
  getDiscordGroupBindingForBotLabel,
  getDiscordGroupBindingForGroup,
} from './groups.js';

describe('discord group bindings', () => {
  it('resolves workshop bot label to canonical group folder', () => {
    const binding = getDiscordGroupBindingForBotLabel('workshop');
    expect(binding?.canonicalGroupFolder).toBe('discord_workshop_teamlead');
    expect(binding?.requiresTrigger).toBe(false);
    expect(binding?.responsePolicy).toBe('always');
  });

  it('maps legacy alias folders to canonical folders', () => {
    expect(getDiscordCanonicalGroupFolderForFolder('discord_workshop')).toBe(
      'discord_workshop_teamlead',
    );
    expect(getDiscordCanonicalGroupFolderForFolder('discord_planning')).toBe(
      'discord_planning_bot',
    );
    expect(getDiscordCanonicalGroupFolderForFolder('discord_secretary')).toBe(
      'discord_secretary_bot',
    );
  });

  it('finds bindings by canonical and alias folders', () => {
    expect(
      getDiscordGroupBindingForGroup('discord_workshop_kimi')?.botLabel,
    ).toBe('kimi');
    expect(getDiscordGroupBindingForGroup('discord_workshop')?.botLabel).toBe(
      'workshop',
    );
  });
});
