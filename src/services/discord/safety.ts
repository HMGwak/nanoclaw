import { NewMessage, RegisteredGroup } from '../../types.js';
import { getDiscordDeploymentForGroup } from './deployments.js';

const CURRENT_AFFAIRS_PATTERN =
  /(?:\btrump\b|\biran\b|\bwar\b|\bconflict\b|\belection\b|\bsanction\b|\bdiplomacy\b|트럼프|이란|전쟁|충돌|선거|제재|외교|중동|우크라이나|러시아|북핵|핵무기|군사)/iu;

function getLatestMessageContent(messages: NewMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content?.trim();
    if (content) return content;
  }
  return '';
}

export function isDiscordCurrentAffairsTurn(messages: NewMessage[]): boolean {
  const latestContent = getLatestMessageContent(messages);
  if (!latestContent) return false;
  return CURRENT_AFFAIRS_PATTERN.test(latestContent);
}

export function buildDiscordCurrentAffairsSafetyBlock(
  group: RegisteredGroup,
  messages: NewMessage[],
): string {
  if (!isDiscordCurrentAffairsTurn(messages)) return '';

  const deployment = getDiscordDeploymentForGroup(group);
  if (!deployment) return '';

  return [
    '[CURRENT_AFFAIRS_SAFETY]',
    `department: ${deployment.departmentId}`,
    '- This turn may involve live or unstable geopolitical/political facts.',
    '- Verify with tools/sources first when possible. If blocked, clearly mark what is unverified.',
    '- Do not present war/election winner-loser outcomes as settled fact.',
    '- Use condition-based scenario framing and explicit uncertainty.',
    '- Keep the visible reply concise by default (no long monologue unless requested).',
  ].join('\n');
}
