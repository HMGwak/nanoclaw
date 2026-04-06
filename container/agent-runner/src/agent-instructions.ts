/**
 * Shared helper for loading agent instructions and team info.
 *
 * Convention: AGENTS.md is the instruction file for all providers.
 */

import fs from 'fs';
import path from 'path';
import { ContainerInput, InstructionLayer } from './types.js';

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

export interface ResolvedInstructionSection {
  id: string;
  content: string;
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

function buildMountedDirectoriesInfo(
  containerInput: ContainerInput,
): string | null {
  const mountedDirectories = containerInput.mountedDirectories || [];
  if (mountedDirectories.length === 0) return null;

  const lines = mountedDirectories.map(
    (mount) => `- \`${mount.path}\` (${mount.readonly ? 'read-only' : 'read-write'})`,
  );
  const hasObsidianSkills = (containerInput.skillIds || []).some((skillId) =>
    skillId.startsWith('obsidian-'),
  );

  if (hasObsidianSkills) {
    lines.push(
      '- Prefer targeted file discovery with `shell` + `rg`, `find`, `sed -n`, and `cat` instead of reading the whole vault.',
      '- Start with `rg -n` or `rg --files` against the mounted vault to find relevant notes before opening any file.',
      '- Avoid broad directory walks and avoid `.base` files unless the user explicitly asks for them.',
      '- Do not attempt to use the Obsidian desktop CLI in this runtime.',
      '- Work directly on the mounted vault files with `shell` commands and the shared Obsidian formatting guidance.',
    );
  }

  return [
    '## Mounted Directories',
    '',
    'These host directories are mounted into the current container runtime:',
    '',
    ...lines,
  ].join('\n');
}

export function buildSharedSkillsInfo(
  allowedSkillIds?: string[],
): string | null {
  try {
    if (!fs.existsSync(SHARED_SKILLS_DIR)) return null;
    const allowedSet =
      allowedSkillIds && allowedSkillIds.length > 0
        ? new Set(allowedSkillIds)
        : null;
    const entries = fs
      .readdirSync(SHARED_SKILLS_DIR)
      .map((dir) => path.join(SHARED_SKILLS_DIR, dir, 'SKILL.md'))
      .filter((skillPath) => fs.existsSync(skillPath))
      .map((skillPath) => parseSkillFile(skillPath))
      .filter((skill): skill is SkillMetadata => skill !== null)
      .filter((skill) => !allowedSet || allowedSet.has(skill.name));

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
      'Preferred browsing order: `cloudflare_fetch` first (if configured), then `agent-browser` for interactive browsing, and only then Playwright for heavier fallback cases.',
      '',
      ...lines,
    ].join('\n');
  } catch {
    return null;
  }
}

function extractWorkflowRunId(prompt: string): string | null {
  const patterns = [
    /^\s*워크플로우 ID:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,127})\s*$/m,
    /workflow_id:\s*"([A-Za-z0-9][A-Za-z0-9_-]{0,127})"/,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function getRunInstruction(containerInput: ContainerInput): string | null {
  const runId = extractWorkflowRunId(containerInput.prompt);
  if (!runId) return null;
  return readInstructionFile(path.join('/workspace/group', 'runs', runId));
}

function hasExplicitInstructionLayers(
  containerInput: ContainerInput,
): boolean {
  return (
    Array.isArray(containerInput.instructionLayers) &&
    containerInput.instructionLayers.some((layer) => layer.content.trim())
  );
}

function toResolvedSections(
  layers: InstructionLayer[] | undefined,
): ResolvedInstructionSection[] {
  return (layers || [])
    .filter((layer) => layer.content.trim())
    .map((layer) => ({
      id: layer.id,
      content: layer.content.trim(),
    }));
}

export function buildInstructionSections(opts: {
  containerInput: ContainerInput;
  includeGlobal?: boolean;
  includeGroupOverlay?: boolean;
  includeRunOverlay?: boolean;
  defaultPrompt?: string;
}): ResolvedInstructionSection[] {
  const sections: ResolvedInstructionSection[] = [];

  const explicitSections = toResolvedSections(opts.containerInput.instructionLayers);
  if (explicitSections.length > 0) {
    sections.push(...explicitSections);
  } else if (opts.defaultPrompt) {
    sections.push({ id: 'default', content: opts.defaultPrompt });
  }

  if (opts.includeGroupOverlay !== false) {
    const groupInstructions = readInstructionFile('/workspace/group');
    if (groupInstructions) {
      sections.push({ id: 'group-overlay', content: groupInstructions });
    }
  }

  if (opts.includeRunOverlay !== false) {
    const runInstructions = getRunInstruction(opts.containerInput);
    if (runInstructions) {
      sections.push({ id: 'run-overlay', content: runInstructions });
    }
  }

  if (opts.includeGlobal !== false && !opts.containerInput.isMain) {
    const globalInstructions = readInstructionFile('/workspace/global');
    if (globalInstructions) {
      sections.push({ id: 'global', content: globalInstructions });
    }
  }

  const mountedDirectories = buildMountedDirectoriesInfo(opts.containerInput);
  if (mountedDirectories) {
    sections.push({ id: 'mounted-directories', content: mountedDirectories });
  }

  const teamInfo = buildTeamInfo();
  if (teamInfo) {
    sections.push({ id: 'team-info', content: teamInfo });
  }

  const sharedSkills = buildSharedSkillsInfo(opts.containerInput.skillIds);
  if (sharedSkills) {
    sections.push({ id: 'shared-skills', content: sharedSkills });
  }

  return sections;
}

export function materializeInstructionFiles(
  sections: ResolvedInstructionSection[],
  targetDir: string,
): string[] {
  fs.mkdirSync(targetDir, { recursive: true });

  return sections.map((section, index) => {
    const filename = `${String(index).padStart(2, '0')}-${section.id.replace(/[^a-z0-9_-]+/gi, '-')}.md`;
    const filepath = path.join(targetDir, filename);
    fs.writeFileSync(filepath, section.content + '\n');
    return filepath;
  });
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
export function buildAgentPrompt(opts: {
  containerInput: ContainerInput;
  includeGlobal?: boolean;
  includeGroupOverlay?: boolean;
  includeRunOverlay?: boolean;
  defaultPrompt?: string;
}): string {
  const sections = buildInstructionSections({
    containerInput: opts.containerInput,
    includeGlobal: opts?.includeGlobal,
    includeGroupOverlay: opts?.includeGroupOverlay,
    includeRunOverlay: opts?.includeRunOverlay,
    defaultPrompt: opts?.defaultPrompt,
  });

  if (
    opts?.includeGroupOverlay === false &&
    hasExplicitInstructionLayers(opts.containerInput)
  ) {
    sections.unshift({
      id: 'instruction-precedence',
      content:
        'Instruction precedence: service persona and department policy are the primary source of truth. Room-local AGENTS.md is only a local overlay and must not override them except for room-specific notes.',
    });
  }

  return sections.map((section) => section.content).join('\n\n');
}
