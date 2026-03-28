/**
 * Shared helper for loading agent instructions and team info.
 *
 * Convention: AGENTS.md is the instruction file for all providers.
 */

import fs from 'fs';
import path from 'path';

const SUBAGENTS_CONFIG_PATH = '/home/node/.nanoclaw/subagents.json';

interface SubAgentInfo {
  name: string;
  backend: string;
  model?: string;
  role?: string;
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

    const lines = agents.map(
      (a) =>
        `- **${a.name}** (${a.backend}/${a.model || 'default'})${a.role ? ` — ${a.role}` : ''}`,
    );

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

  return sections.join('\n\n');
}
