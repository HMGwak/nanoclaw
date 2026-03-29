import {
  appendSharedContextMessage,
  listSharedContextMessages,
} from '../../db.js';
import { RegisteredGroup } from '../../types.js';
import { getDiscordDeploymentForGroup } from './deployments.js';
import { getDiscordPersonnelSpec } from './resources/personnel.js';

const DEFAULT_SHARED_CONTEXT_LIMIT = 30;

interface DiscordSharedContextScope {
  service: 'discord';
  departmentId: string;
  channelKey: string;
}

function resolveDiscordChannelKey(chatJid: string): string | null {
  if (!chatJid.startsWith('dc:')) return null;
  const channelId = chatJid.replace(/^dc:/, '').split(':')[0]?.trim();
  if (!channelId) return null;
  return `dc:${channelId}`;
}

function resolveDiscordSharedContextScope(
  group: RegisteredGroup,
  chatJid: string,
): DiscordSharedContextScope | null {
  const deployment = getDiscordDeploymentForGroup(group);
  if (!deployment) return null;
  const channelKey = resolveDiscordChannelKey(chatJid);
  if (!channelKey) return null;
  return {
    service: 'discord',
    departmentId: deployment.departmentId,
    channelKey,
  };
}

function resolveLeadDisplayName(group: RegisteredGroup): string {
  const deployment = getDiscordDeploymentForGroup(group);
  if (!deployment) return group.name;
  const lead = getDiscordPersonnelSpec(deployment.leadPersonnelId);
  return lead?.displayName || group.name;
}

export function recordDiscordSharedVisibleReply(
  group: RegisteredGroup,
  chatJid: string,
  sender: string | undefined,
  content: string,
  createdAt?: string,
): void {
  const scope = resolveDiscordSharedContextScope(group, chatJid);
  if (!scope) return;
  const trimmedContent = content.trim();
  if (!trimmedContent) return;
  const senderName = sender?.trim() || resolveLeadDisplayName(group);

  appendSharedContextMessage({
    service: scope.service,
    departmentId: scope.departmentId,
    channelKey: scope.channelKey,
    senderName,
    content: trimmedContent,
    createdAt,
    retentionLimit: DEFAULT_SHARED_CONTEXT_LIMIT,
  });
}

export function buildDiscordSharedContextBlock(
  group: RegisteredGroup,
  chatJid: string,
  opts?: { beforeTimestamp?: string; limit?: number; includeOwnSender?: boolean },
): string {
  const scope = resolveDiscordSharedContextScope(group, chatJid);
  if (!scope) return '';

  const rows = listSharedContextMessages({
    service: scope.service,
    departmentId: scope.departmentId,
    channelKey: scope.channelKey,
    beforeTimestamp: opts?.beforeTimestamp,
    limit: opts?.limit || DEFAULT_SHARED_CONTEXT_LIMIT,
  });

  if (rows.length === 0) return '';

  const ownSender = resolveLeadDisplayName(group).trim();
  const includeOwnSender = opts?.includeOwnSender === true;
  const filteredRows = includeOwnSender
    ? rows
    : rows.filter((row) => row.sender_name.trim() !== ownSender);
  if (filteredRows.length === 0) return '';

  const lines = filteredRows.map(
    (row) => `- [${row.created_at}] ${row.sender_name}: ${row.content}`,
  );

  return [
    '[DEPARTMENT_SHARED_CONTEXT]',
    `department: ${scope.departmentId}`,
    `channel: ${scope.channelKey}`,
    ...lines,
  ].join('\n');
}
