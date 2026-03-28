import { getConfiguredSpeakerNames, getLeadSenderName } from './agents/index.js';
import { RegisteredGroup } from './types.js';

export interface NormalizedAgentOutput {
  text: string;
  sender?: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function configuredSpeakerNames(group: RegisteredGroup): string[] {
  return getConfiguredSpeakerNames(group);
}

function stripInternalBlocks(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function extractVisibleBlocks(
  text: string,
): Array<{ sender?: string; text: string }> {
  const matches = Array.from(
    text.matchAll(
      /<visible(?:\s+sender=(?:"([^"]+)"|'([^']+)'))?\s*>([\s\S]*?)<\/visible>/giu,
    ),
  );

  return matches
    .map((match) => ({
      sender: (match[1] || match[2] || '').trim() || undefined,
      text: match[3].trim(),
    }))
    .filter((entry) => entry.text.length > 0);
}

function stripSpeakerPrefix(text: string, sender?: string): string {
  if (!sender) return text.trim();
  const prefix = new RegExp(`^\\s*${escapeRegex(sender)}\\s*[:：]\\s*`, 'u');
  return text.replace(prefix, '').trim();
}

function findSenderPrefix(
  text: string,
  group: RegisteredGroup,
): string | undefined {
  for (const name of configuredSpeakerNames(group)) {
    const prefix = new RegExp(`^\\s*${escapeRegex(name)}\\s*[:：]\\s*`, 'u');
    if (prefix.test(text)) {
      return name;
    }
  }
  return undefined;
}

function extractSpeakerTranscript(
  text: string,
  group: RegisteredGroup,
  explicitSender?: string,
): NormalizedAgentOutput[] {
  const names = configuredSpeakerNames(group);
  if (names.length === 0) return [];

  const alternation = names
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  const regex = new RegExp(`(^|\\n)\\s*(${alternation})\\s*[:：]\\s*`, 'gu');
  const matches = Array.from(text.matchAll(regex));
  if (matches.length === 0) return [];

  const outputs: NormalizedAgentOutput[] = [];
  const firstIndex = matches[0].index ?? 0;
  const leading = text.slice(0, firstIndex).trim();
  if (leading && explicitSender) {
    outputs.push({
      text: stripSpeakerPrefix(leading, explicitSender),
      sender: explicitSender,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const sender = current[2];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? text.length;
    const segment = text.slice(start, end).trim();
    if (!segment) continue;
    outputs.push({
      text: stripSpeakerPrefix(segment, sender),
      sender,
    });
  }

  return outputs;
}

export function normalizeAgentOutputs(
  raw: string,
  group: RegisteredGroup,
  explicitSender?: string,
): NormalizedAgentOutput[] {
  const withoutInternal = stripInternalBlocks(raw);
  if (!withoutInternal) return [];

  const visibleBlocks = extractVisibleBlocks(withoutInternal);
  if (visibleBlocks.length > 0) {
    return visibleBlocks.map((block) => ({
      text: stripSpeakerPrefix(
        block.text,
        block.sender || getLeadSenderName(group),
      ),
      sender: block.sender || getLeadSenderName(group),
    }));
  }

  const transcript = extractSpeakerTranscript(
    withoutInternal,
    group,
    explicitSender,
  );
  if (transcript.length > 0) {
    return transcript;
  }

  const sender =
    findSenderPrefix(withoutInternal, group) ||
    explicitSender ||
    getLeadSenderName(group);
  return [
    {
      text: stripSpeakerPrefix(withoutInternal, sender),
      sender,
    },
  ];
}

export function normalizeAgentOutput(
  raw: string,
  group: RegisteredGroup,
  explicitSender?: string,
): NormalizedAgentOutput | null {
  return normalizeAgentOutputs(raw, group, explicitSender)[0] || null;
}
