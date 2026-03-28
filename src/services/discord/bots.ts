import { readEnvFile } from '../../env.js';

export interface AdditionalDiscordBotConfig {
  label: string;
  token: string;
}

const DISCOVERED_TOKEN_KEYS = [
  'DISCORD_BOT_TOKEN_WORKSHOP',
  'DISCORD_BOT_TOKEN_KIMI',
  'DISCORD_BOT_TOKEN_RESEARCH',
  'DISCORD_BOT_TOKEN_SUPPORT',
  'DISCORD_BOT_TOKEN_ADMIN',
  'DISCORD_BOT_TOKEN_PLANNING',
];

export function loadDiscordServiceBots(): AdditionalDiscordBotConfig[] {
  const envFileContent = readEnvFile(DISCOVERED_TOKEN_KEYS);
  const allEnv = { ...envFileContent, ...process.env };
  const bots: AdditionalDiscordBotConfig[] = [];

  for (const [key, value] of Object.entries(allEnv)) {
    if (
      key.startsWith('DISCORD_BOT_TOKEN_') &&
      value &&
      key !== 'DISCORD_BOT_TOKEN'
    ) {
      bots.push({
        label: key.replace('DISCORD_BOT_TOKEN_', '').toLowerCase(),
        token: value,
      });
    }
  }

  return bots;
}
