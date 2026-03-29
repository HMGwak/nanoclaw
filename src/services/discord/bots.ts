import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import { listDiscordBotResources } from './resources/bots.js';

export interface AdditionalDiscordBotConfig {
  label: string;
  token: string;
}

function discoverConfiguredTokenKeys(): string[] {
  const keys = new Set<string>();

  for (const envKey of Object.keys(process.env)) {
    if (envKey.startsWith('DISCORD_BOT_TOKEN_')) {
      keys.add(envKey);
    }
  }

  const envFile = path.join(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key.startsWith('DISCORD_BOT_TOKEN_')) {
        keys.add(key);
      }
    }
  }

  return [...keys].sort();
}

export function loadDiscordServiceBots(): AdditionalDiscordBotConfig[] {
  const preferredLabels = new Set<string>(
    listDiscordBotResources()
      .map((resource) => resource.botLabel.trim().toLowerCase())
      .filter((label) => label && label !== 'primary'),
  );

  const discoveredTokenKeys = discoverConfiguredTokenKeys();
  const envLabels = discoveredTokenKeys.map((key) =>
    key.replace('DISCORD_BOT_TOKEN_', '').toLowerCase(),
  );
  const resolvedLabels = Array.from(
    new Set([...preferredLabels, ...envLabels]),
  ).sort();

  logger.debug(
    {
      labelCount: resolvedLabels.length,
      labels: resolvedLabels,
    },
    'Discord service bot labels discovered from resources',
  );

  const envFileContent = readEnvFile(discoveredTokenKeys);
  const allEnv = { ...envFileContent, ...process.env };
  const bots: AdditionalDiscordBotConfig[] = [];

  for (const label of resolvedLabels) {
    const key = `DISCORD_BOT_TOKEN_${label.toUpperCase()}`;
    const token = allEnv[key];
    if (token) {
      bots.push({
        label,
        token,
      });
      continue;
    }

    logger.warn({ label, key }, 'Discord bot token missing for required label');
  }

  return bots;
}
