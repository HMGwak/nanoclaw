import fs from 'fs';
import path from 'path';

const PROMPT_FILES: Record<string, string> = {
  discord_workshop_teamlead: 'workshop-teamlead.md',
  discord_workshop_kimi: 'workshop-kimi.md',
  discord_planning_lead: 'planning-lead.md',
  discord_secretary_lead: 'secretary-lead.md',
};

function promptPath(filename: string): string {
  return path.join(
    process.cwd(),
    'src',
    'services',
    'discord',
    'resources',
    'prompts',
    filename,
  );
}

export function getDiscordPersonnelPrompt(id: string): string | null {
  const filename = PROMPT_FILES[id];
  if (!filename) return null;
  const filepath = promptPath(filename);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, 'utf-8').trim();
}
