import fs from 'fs';
import path from 'path';

export type DiscordDepartmentId = 'workshop' | 'planning' | 'secretary';

export interface DiscordDepartmentSpec {
  id: DiscordDepartmentId;
  displayName: string;
  prompt: string | null;
  handoffTemplate: string | null;
}

const DEPARTMENT_NAMES: Record<DiscordDepartmentId, string> = {
  workshop: '작업실',
  planning: '기획실',
  secretary: '비서실',
};

function departmentAgentsPath(departmentId: DiscordDepartmentId): string {
  return path.join(
    process.cwd(),
    'src',
    'services',
    'discord',
    'departments',
    departmentId,
    'AGENTS.md',
  );
}

export function getDiscordDepartmentPrompt(
  departmentId: DiscordDepartmentId,
): string | null {
  const filepath = departmentAgentsPath(departmentId);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, 'utf-8').trim();
}

function handoffTemplatePath(): string {
  return path.join(
    process.cwd(),
    'src',
    'services',
    'discord',
    'departments',
    'handoff',
    'template.md',
  );
}

export function getDiscordDepartmentSpec(
  departmentId: DiscordDepartmentId,
): DiscordDepartmentSpec {
  const handoffPath = handoffTemplatePath();
  return {
    id: departmentId,
    displayName: DEPARTMENT_NAMES[departmentId],
    prompt: getDiscordDepartmentPrompt(departmentId),
    handoffTemplate: fs.existsSync(handoffPath)
      ? fs.readFileSync(handoffPath, 'utf-8').trim()
      : null,
  };
}
