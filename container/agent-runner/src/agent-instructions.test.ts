import { describe, expect, it, vi } from 'vitest';

const SKILL_ROOT = '/home/node/.nanoclaw/skills';
const SKILL_FILES = new Map<string, string>([
  [
    `${SKILL_ROOT}/agent-browser/SKILL.md`,
    `---
name: agent-browser
description: Browser automation guidance.
---
# Agent Browser

Use agent-browser for interactive browsing.
Prefer it over heavier tooling.
`,
  ],
  [
    `${SKILL_ROOT}/obsidian-markdown/SKILL.md`,
    `---
name: obsidian-markdown
description: Obsidian Markdown guidance.
---
# Obsidian Markdown

Write valid Obsidian Markdown files.
Use wikilinks for internal vault references.
`,
  ],
]);

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn((filepath: string) => {
      return filepath === SKILL_ROOT || SKILL_FILES.has(filepath);
    }),
    readdirSync: vi.fn((dir: string) => {
      if (dir === SKILL_ROOT) {
        return ['agent-browser', 'obsidian-markdown'];
      }
      return [];
    }),
    readFileSync: vi.fn((filepath: string) => SKILL_FILES.get(filepath) || ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

import { buildAgentPrompt } from './agent-instructions.js';

describe('agent instructions', () => {
  it('filters shared skills by runtime skill ids and documents mounted vault fallback guidance', () => {
    const prompt = buildAgentPrompt({
      containerInput: {
        prompt: 'vault 상태를 점검해줘',
        groupFolder: 'discord_secretary_bot',
        chatJid: 'dc:test',
        isMain: false,
        skillIds: ['obsidian-markdown'],
        mountedDirectories: [
          {
            path: '/workspace/extra/obsidian-vault',
            readonly: true,
          },
        ],
      },
      includeGlobal: false,
      includeGroupOverlay: false,
      includeRunOverlay: false,
      defaultPrompt: 'You are an AI assistant.',
    });

    expect(prompt).toContain('## Mounted Directories');
    expect(prompt).toContain('/workspace/extra/obsidian-vault');
    expect(prompt).toContain('read-only');
    expect(prompt).toContain('Start with `rg -n` or `rg --files`');
    expect(prompt).toContain('Avoid broad directory walks and avoid `.base` files');
    expect(prompt).toContain('Do not attempt to use the Obsidian desktop CLI');
    expect(prompt).toContain('shell` + `rg`');
    expect(prompt).toContain('**obsidian-markdown**');
    expect(prompt).not.toContain('**agent-browser**');
  });
});
