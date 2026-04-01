import { ToolsetSpec } from './types.js';

const TOOLSETS: Record<string, ToolsetSpec> = {
  global_general_cli: {
    id: 'global_general_cli',
    description: 'General-purpose global toolset for planning and execution.',
    allowedTools: null,
    skillIds: ['agent-browser'],
  },
  obsidian_vault_tools: {
    id: 'obsidian_vault_tools',
    description:
      'Obsidian vault tools for creating and editing Markdown notes, Bases, Canvas files, and CLI interaction.',
    allowedTools: null,
    skillIds: [
      'obsidian-markdown',
      'obsidian-bases',
      'obsidian-canvas',
      'obsidian-cli',
      'defuddle',
    ],
    sourceModuleIds: ['obsidian_skills'],
  },
  global_browser_research: {
    id: 'global_browser_research',
    description:
      'Browser-first global research toolset with enforced Cloudflare -> agent-browser -> Playwright progression.',
    allowedTools: [
      'web_search',
      'web_fetch',
      'cloudflare_fetch',
      'browse_open',
      'browse_click',
      'browse_fill',
      'browse_select',
      'browse_snapshot',
      'browse_screenshot',
      'browse_get_text',
      'browse_press',
      'browse_close',
      'playwright_open',
      'playwright_screenshot',
      'playwright_execute',
      'playwright_extract',
      'playwright_pdf',
    ],
    skillIds: ['agent-browser'],
    sourceModuleIds: [
      'cloudflare_browser_rendering',
      'vercel_agent_browser',
      'playwright',
    ],
    browserPolicy: {
      id: 'browser_stack_v1',
      enforcement: 'hard',
      chain: ['cloudflare_fetch', 'agent_browser', 'playwright'],
      supplementalTools: ['web_search', 'web_fetch'],
    },
  },
};

export function getToolsetSpec(id: string): ToolsetSpec | null {
  return TOOLSETS[id] || null;
}

export function listToolsetSpecs(): ToolsetSpec[] {
  return Object.values(TOOLSETS);
}
