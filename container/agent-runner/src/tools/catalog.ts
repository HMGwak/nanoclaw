import OpenAI from 'openai';
import { DEBATE_MODE_IDS } from './debate-orchestration.js';

export const allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Execute a shell command inside the container workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          working_directory: {
            type: 'string',
            description: 'Working directory. Defaults to /workspace/group.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web using DuckDuckGo and return results. Use for query-based lookup when you do not have a direct URL.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a URL and return the response body as text. Prefer cloudflare_fetch first when configured; use this for simple pages and lightweight fallback.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to fetch.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cloudflare_fetch',
      description:
        'Fetch a URL through Cloudflare Browser Rendering content endpoint and return rendered page content. Prefer this first when Browser Rendering credentials are configured.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to render and fetch.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_open',
      description:
        'Open a URL and get accessibility snapshot with interactive element refs (@e1, @e2...). Token-efficient. Prefer this before Playwright for most browsing and interactive page tasks.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_click',
      description:
        'Click an element by ref (e.g. @e1) and return updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref like @e1.' },
        },
        required: ['ref'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_fill',
      description:
        'Fill a form field by ref with text and return updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref like @e1.' },
          text: { type: 'string', description: 'Text to fill.' },
        },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_select',
      description: 'Select a dropdown option by ref.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref like @e1.' },
          option: { type: 'string', description: 'Option to select.' },
        },
        required: ['ref', 'option'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_snapshot',
      description:
        'Get current page accessibility snapshot without any action.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_screenshot',
      description:
        'Take a screenshot of the current page (base64 PNG). Uses agent-browser.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_get_text',
      description: 'Get text content from an element ref or the full page.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element ref (omit for full page).',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_press',
      description: 'Press a keyboard key (e.g. Enter, Tab, Escape).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to press.' },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browse_close',
      description: 'Close the browser session.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'playwright_open',
      description:
        'Open URL with Playwright and extract full page text. Heavier and more expensive than browse_open. Use only after web_search/web_fetch and agent-browser are insufficient.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'playwright_screenshot',
      description:
        'Take a screenshot with Playwright. Returns base64 PNG. Use when visual inspection is needed and agent-browser is not sufficient.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to screenshot.' },
          fullPage: {
            type: 'boolean',
            description: 'Capture full page (default: false).',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'playwright_execute',
      description:
        'Run custom Playwright actions on a page. Heavy advanced automation fallback after lighter browser tools are insufficient.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to.' },
          script: {
            type: 'string',
            description:
              'Playwright actions (e.g. await page.click("button");).',
          },
        },
        required: ['url', 'script'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'playwright_extract',
      description:
        'Extract structured data from a page using CSS selectors. Prefer lighter tools first; use this when targeted Playwright extraction is genuinely needed.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to extract from.' },
          selectors: {
            type: 'object',
            description:
              'Map of name to CSS selector, e.g. {"title": "h1", "prices": ".price"}.',
          },
        },
        required: ['url', 'selectors'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'playwright_pdf',
      description: 'Generate PDF of a webpage. Returns base64.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to convert to PDF.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List available sub-agents (team members) and their roles.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_agent',
      description:
        'Ask a sub-agent for help. Use this when you want a second opinion, implementation advice, or focused review from a team member.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Name of the sub-agent.' },
          prompt: {
            type: 'string',
            description: 'The question or task for the sub-agent.',
          },
          system_prompt: {
            type: 'string',
            description:
              'Optional extra system instructions for the sub-agent.',
          },
        },
        required: ['agent', 'prompt'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_debate',
      description:
        'Run a planning-led internal debate with workshop participants using objective evidence packs, and return round summaries plus a synthesis recommendation.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Debate topic or decision under review.',
          },
          mode: {
            type: 'string',
            enum: [...DEBATE_MODE_IDS],
            description: 'Debate mode to run.',
          },
          rounds: {
            type: 'number',
            minimum: 1,
            maximum: 12,
            description: 'Optional round override.',
          },
          background_knowledge_refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional background references or context pointers.',
          },
          evidence_packs: {
            type: 'array',
            description:
              'Required structured evidence for the debate. Collect objective material first and pass it here so participants debate from the same evidence base.',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['web', 'file', 'memory', 'karpathy_loop_brief'],
                  description: 'Evidence pack type.',
                },
                ref: {
                  type: 'string',
                  minLength: 1,
                  description: 'Reference identifier for the evidence pack.',
                },
                title: { type: 'string', description: 'Optional title.' },
                summary: {
                  type: 'string',
                  description: 'Optional short summary.',
                },
              },
              required: ['type', 'ref'],
              additionalProperties: false,
            },
          },
        },
        required: ['topic', 'mode', 'evidence_packs'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description:
        "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message text to send.' },
          sender: {
            type: 'string',
            description:
              'Your role/identity name (e.g. "Researcher"). Optional.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_workflow',
      description:
        'Start a workflow on the host. Use this to trigger multi-step processes like wiki synthesis via the quality-loop engine.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Workflow title (e.g. "Wiki Synthesis: 안전성검토")',
          },
          steps: {
            type: 'array',
            description: 'Workflow steps to execute',
            items: {
              type: 'object',
              properties: {
                assignee: {
                  type: 'string',
                  description: 'Agent or bot ID to assign the step to',
                },
                goal: {
                  type: 'string',
                  description: 'What this step should accomplish',
                },
                acceptance_criteria: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Array of criteria strings. For quality-loop, include a JSON config string.',
                },
                constraints: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional constraints for the step',
                },
                stage_id: {
                  type: 'string',
                  description: 'Flow stage ID (e.g. "execute")',
                },
              },
              required: ['assignee', 'goal', 'acceptance_criteria', 'stage_id'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'steps'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wiki_synthesis',
      description:
        'Start a spec-driven wiki synthesis or update workflow. Provide domain and wiki_output_dir — base_file is auto-discovered from the domain name if omitted. Ask the user for wiki_output_dir if not specified.',
      parameters: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name (e.g. "안전성검토", "첨가물정보제출")',
          },
          wiki_output_dir: {
            type: 'string',
            description:
              'Absolute host path to the Obsidian folder where the finished wiki note will be saved (e.g. /Users/planee/Documents/Mywork/3. Resource/LLM Knowledge Base/wiki)',
          },
          base_file: {
            type: 'string',
            description: 'Optional: path to .base index file. Auto-discovered if omitted.',
          },
          filter: {
            type: 'string',
            description: 'Optional glob filter pattern for documents',
          },
          vault_root: {
            type: 'string',
            description:
              'Obsidian vault root host path. Defaults to /Users/planee/Documents/Mywork',
          },
          model: {
            type: 'string',
            description: 'LLM model override (default: gpt-5.4)',
          },
        },
        required: ['domain', 'wiki_output_dir'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'safe_shell',
      description:
        'Run a read-only shell command for exploration (ls, cat, find, grep, etc.). Destructive commands (rm, mv, chmod, redirects) are blocked.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run (read-only operations only)',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
];

export function filterTools(
  allowedTools?: string[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (!allowedTools) return allTools;
  return allTools.filter((tool) => {
    const fn = tool as { type: string; function: { name: string } };
    return fn.type === 'function' && allowedTools.includes(fn.function.name);
  });
}

export function getToolName(
  tool: OpenAI.Chat.Completions.ChatCompletionTool,
): string {
  return (tool as { function: { name: string } }).function.name;
}
