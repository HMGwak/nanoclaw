import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: fsMock.existsSync,
      readFileSync: fsMock.readFileSync,
    },
  };
});

vi.mock('../../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const values: Record<string, string> = {};
    for (const key of keys) {
      if (key === 'DISCORD_BOT_TOKEN_WORKSHOP') values[key] = 'workshop-token';
      if (key === 'DISCORD_BOT_TOKEN_PLANNING') values[key] = 'planning-token';
    }
    return values;
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { loadDiscordServiceBots } from './bots.js';

describe('loadDiscordServiceBots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      [
        'DISCORD_BOT_TOKEN=primary',
        'DISCORD_BOT_TOKEN_WORKSHOP=workshop-token',
        'DISCORD_BOT_TOKEN_PLANNING=planning-token',
      ].join('\n'),
    );
  });

  it('loads secondary bots declared in env even when no senderBotMap references them', () => {
    const bots = loadDiscordServiceBots();

    expect(bots).toEqual([
      { label: 'planning', token: 'planning-token' },
      { label: 'workshop', token: 'workshop-token' },
    ]);
  });
});
