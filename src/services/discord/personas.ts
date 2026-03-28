import { RegisteredGroup } from '../../types.js';
import {
  resolveGroupPersonaBotLabel,
  resolveGroupPersonaMode,
} from '../index.js';

export function resolveDiscordPersonaBotLabel(
  group: RegisteredGroup | undefined,
  sender?: string,
): string | undefined {
  return resolveGroupPersonaBotLabel(group, sender);
}

export function resolveDiscordPersonaMode(
  group: RegisteredGroup | undefined,
): 'hybrid' | 'bot_only' {
  return resolveGroupPersonaMode(group);
}

export function normalizeDiscordPersonaText(
  text: string,
  sender?: string,
): string {
  if (!sender) return text;
  const escapedSender = sender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = new RegExp(`^\\s*${escapedSender}\\s*[:：]\\s*`, 'u');
  return text.replace(prefix, '');
}
