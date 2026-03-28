/**
 * Shared helper for loading agent instructions and team info.
 *
 * Convention: AGENTS.md is the instruction file for all providers.
 */

import fs from 'fs';
import path from 'path';

const SUBAGENTS_CONFIG_PATH = '/home/node/.nanoclaw/subagents.json';
const SHARED_SKILLS_DIR = '/home/node/.nanoclaw/skills';

interface SubAgentInfo {
  name: string;
  backend: string;
  model?: string;
  role?: string;
  allowedTools?: string[];
}

interface SkillMetadata {
  name: string;
  description: string;
  body: string;
}

/**
 * Read AGENTS.md from a directory. Returns null if not found.
 */
export function readInstructionFile(dir: string): string | null {
  const filepath = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(filepath)) {
    return fs.readFileSync(filepath, 'utf-8').trim();
  }
  return null;
}

/**
 * Return the path to AGENTS.md in a directory, or null if not found.
 */
export function findInstructionFile(dir: string): string | null {
  const filepath = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(filepath)) return filepath;
  return null;
}

function parseSkillFile(skillPath: string): SkillMetadata | null {
  try {
    const raw = fs.readFileSync(skillPath, 'utf-8').trim();
    const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!frontmatterMatch) return null;

    const frontmatter = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();
    let name = '';
    let description = '';

    for (const line of frontmatter.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('name:')) {
        name = trimmed.slice('name:'.length).trim();
      } else if (trimmed.startsWith('description:')) {
        description = trimmed.slice('description:'.length).trim();
      }
    }

    if (!name || !description) return null;
    return { name, description, body };
  } catch {
    return null;
  }
}

function summarizeSkillBody(body: string): string {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const summaryLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (line.startsWith('```')) continue;
    summaryLines.push(line);
    if (summaryLines.length >= 3) break;
  }

  return summaryLines.join(' ');
}

export function buildSharedSkillsInfo(): string | null {
  try {
    if (!fs.existsSync(SHARED_SKILLS_DIR)) return null;
    const entries = fs
      .readdirSync(SHARED_SKILLS_DIR)
      .map((dir) => path.join(SHARED_SKILLS_DIR, dir, 'SKILL.md'))
      .filter((skillPath) => fs.existsSync(skillPath))
      .map((skillPath) => parseSkillFile(skillPath))
      .filter((skill): skill is SkillMetadata => skill !== null);

    if (entries.length === 0) return null;

    const lines = entries.map((skill) => {
      const summary = summarizeSkillBody(skill.body);
      return `- **${skill.name}** — ${skill.description}${summary ? ` | ${summary}` : ''}`;
    });

    return [
      '## Shared Container Skills',
      '',
      'These skills are shared across providers. Use them as behavioral guidance even when your backend does not have a native Skill tool.',
      'When web research is needed, prefer the shared `agent-browser` skill guidance over guessing.',
      'Preferred browsing order: `web_search`/`web_fetch` for simple retrieval, then `agent-browser` for most interactive browsing, and only then Playwright for heavier fallback cases.',
      '',
      ...lines,
    ].join('\n');
  } catch {
    return null;
  }
}

/**
 * Generate team info section from subagents config.
 * Returns null if no sub-agents are configured.
 */
export function buildTeamInfo(): string | null {
  try {
    if (!fs.existsSync(SUBAGENTS_CONFIG_PATH)) return null;
    const agents = JSON.parse(
      fs.readFileSync(SUBAGENTS_CONFIG_PATH, 'utf-8'),
    ) as SubAgentInfo[];
    if (!Array.isArray(agents) || agents.length === 0) return null;

    const lines = agents.map((a) => {
      const toolSummary =
        a.allowedTools && a.allowedTools.length > 0
          ? ` — tools: ${a.allowedTools.join(', ')}`
          : '';
      return `- **${a.name}** (${a.backend}/${a.model || 'default'})${a.role ? ` — ${a.role}` : ''}${toolSummary}`;
    });

    return [
      '## Team Members',
      '',
      'You have team members available via the `ask_agent` tool.',
      'Use them when you need a different perspective, code review, or specialized help.',
      '',
      ...lines,
    ].join('\n');
  } catch {
    return null;
  }
}

/**
 * Build a complete system prompt: group instructions + global instructions + team info.
 */
export function buildAgentPrompt(opts?: {
  includeGlobal?: boolean;
  isMain?: boolean;
  defaultPrompt?: string;
}): string {
  const sections: string[] = [];

  // Group instructions
  const groupInstructions = readInstructionFile('/workspace/group');
  if (groupInstructions) {
    sections.push(groupInstructions);
  } else if (opts?.defaultPrompt) {
    sections.push(opts.defaultPrompt);
  }

  // Global instructions (skip for main group — it already has its own)
  if (opts?.includeGlobal !== false && !opts?.isMain) {
    const globalInstructions = readInstructionFile('/workspace/global');
    if (globalInstructions) {
      sections.push(globalInstructions);
    }
  }

  // Team info (auto-generated from subagents.json)
  const teamInfo = buildTeamInfo();
  if (teamInfo) {
    sections.push(teamInfo);
  }

  const sharedSkills = buildSharedSkillsInfo();
  if (sharedSkills) {
    sections.push(sharedSkills);
  }

  return sections.join('\n\n');
}
