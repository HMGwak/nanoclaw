/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import { loadSubAgentManager } from './sub-agent-manager.js';
import {
  DEBATE_MODE_IDS,
  runDebateWithAgents,
  validateDebateRequest,
} from './tools/debate-orchestration.js';
import { normalizeVaultRoot, toHostPath, findFileByDomain } from './tools/wiki-utils.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.registerTool(
  'send_message',
  {
    description:
      "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
    inputSchema: {
      text: z.string().describe('The message text to send'),
      sender: z
        .string()
        .optional()
        .describe(
          'Your role/identity name (e.g. "Researcher"). On Discord, this may appear as a webhook persona; on other channels it may be ignored.',
        ),
    },
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.registerTool(
  'schedule_task',
  {
    description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
    inputSchema: {
      prompt: z
        .string()
        .describe(
          'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
        ),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .describe(
          'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
        ),
      schedule_value: z
        .string()
        .describe(
          'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
        ),
      context_mode: z
        .enum(['group', 'isolated'])
        .default('group')
        .describe(
          'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
        ),
      target_group_jid: z
        .string()
        .optional()
        .describe(
          '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
        ),
      script: z
        .string()
        .optional()
        .describe(
          'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
        ),
    },
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.registerTool(
  'list_tasks',
  {
    description:
      "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  },
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.registerTool(
  'pause_task',
  {
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: { task_id: z.string().describe('The task ID to pause') },
  },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.registerTool(
  'resume_task',
  {
    description: 'Resume a paused task.',
    inputSchema: { task_id: z.string().describe('The task ID to resume') },
  },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.registerTool(
  'cancel_task',
  {
    description: 'Cancel and delete a scheduled task.',
    inputSchema: { task_id: z.string().describe('The task ID to cancel') },
  },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.registerTool(
  'update_task',
  {
    description:
      'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
    inputSchema: {
      task_id: z.string().describe('The task ID to update'),
      prompt: z.string().optional().describe('New prompt for the task'),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .optional()
        .describe('New schedule type'),
      schedule_value: z
        .string()
        .optional()
        .describe('New schedule value (see schedule_task for format)'),
      script: z
        .string()
        .optional()
        .describe(
          'New script for the task. Set to empty string to remove the script.',
        ),
    },
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.registerTool(
  'register_group',
  {
    description: `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
    inputSchema: {
      jid: z
        .string()
        .describe(
          'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
        ),
      name: z.string().describe('Display name for the group'),
      folder: z
        .string()
        .describe(
          'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
        ),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    },
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.registerTool(
  'run_debate',
  {
    description:
      'Run a planning-led internal debate with workshop participants using objective evidence packs, and return round summaries plus a synthesis recommendation.',
    inputSchema: {
      topic: z
        .string()
        .trim()
        .min(1)
        .describe('Debate topic or decision under review.'),
      mode: z.enum(DEBATE_MODE_IDS).describe('Debate mode to run.'),
      rounds: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe('Optional round override.'),
      background_knowledge_refs: z
        .array(z.string().trim().min(1))
        .optional()
        .describe('Optional background references or context pointers.'),
      evidence_packs: z
        .array(
          z.object({
            type: z.enum(['web', 'file', 'memory', 'karpathy_loop_brief']),
            ref: z.string().trim().min(1),
            title: z.string().trim().min(1).optional(),
            summary: z.string().trim().min(1).optional(),
          }),
        )
        .min(1)
        .describe(
          'Required structured evidence for the debate. Collect objective material first and pass it here so participants debate from the same evidence base.',
        ),
    },
  },
  async (args) => {
    const parsed = validateDebateRequest(args);
    if (!parsed.ok) {
      return {
        content: [{ type: 'text' as const, text: parsed.error }],
        isError: true,
      };
    }

    const manager = loadSubAgentManager();
    if (!manager || manager.size === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'run_debate requires configured internal debate participants.',
          },
        ],
        isError: true,
      };
    }

    const result = await runDebateWithAgents(parsed.request, manager, () => {
      // Debate tool logs stay quiet in stdio mode.
    });
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: result.error }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

// --- Sub-agent tools (ask_agent / list_agents) ---
const subAgentManager = loadSubAgentManager();

if (subAgentManager && subAgentManager.size > 0) {
  const agentNames = subAgentManager
    .listAgents()
    .map((a) => a.name)
    .join(', ');

  server.registerTool(
    'ask_agent',
    {
      description: `Ask a sub-agent (team member) for help. Available agents: ${agentNames}. Each agent is a separate AI model that can provide a different perspective, review code, or answer questions. Each sub-agent uses only its own configured tool allowlist.`,
      inputSchema: {
        agent: z
          .string()
          .describe(`Name of the sub-agent to ask (${agentNames})`),
        prompt: z
          .string()
          .describe('The question or request for the sub-agent'),
        system_prompt: z
          .string()
          .optional()
          .describe(
            'Optional system prompt to set context for the sub-agent',
          ),
      },
    },
    async (args) => {
      try {
        const response = await subAgentManager.askAgent(
          args.agent,
          args.prompt,
          args.system_prompt,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `[${args.agent}] ${response}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error from sub-agent: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_agents',
    {
      description:
        'List available sub-agents (team members) and their roles.',
    },
    async () => {
      const agents = subAgentManager.listAgents();
      const lines = agents.map(
        (a) =>
          `- **${a.name}** (${a.backend}/${a.model || 'default'})${a.role ? ` — ${a.role}` : ''}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text:
              agents.length > 0
                ? `Sub-agents:\n${lines.join('\n')}`
                : 'No sub-agents configured.',
          },
        ],
      };
    },
  );
}

// ── start_workflow ───────────────────────────────────────────────
const canStartWorkflow = process.env.NANOCLAW_CAN_START_WORKFLOW === '1';

if (canStartWorkflow) {
  server.registerTool(
    'start_workflow',
    {
      description:
        'Start a workflow on the host. Use this to trigger multi-step processes like wiki synthesis via the quality-loop engine. The host workflow engine will validate, route, and execute the steps.',
      inputSchema: {
        title: z
          .string()
          .describe('Workflow title (e.g. "Wiki Synthesis: 안전성검토")'),
        steps: z
          .array(
            z.object({
              assignee: z
                .string()
                .describe('Agent or bot ID to assign the step to'),
              goal: z
                .string()
                .describe('What this step should accomplish'),
              acceptance_criteria: z
                .array(z.string())
                .describe(
                  'Array of criteria strings. For quality-loop, include a JSON config string.',
                ),
              constraints: z
                .array(z.string())
                .optional()
                .describe('Optional constraints for the step'),
              stage_id: z
                .string()
                .describe('Flow stage ID (e.g. "execute")'),
            }),
          )
          .describe('Workflow steps to execute'),
      },
    },
    async (args) => {
      const data = {
        type: 'start_workflow',
        chatJid,
        groupFolder,
        title: args.title,
        steps: args.steps,
        timestamp: new Date().toISOString(),
      };

      const filename = writeIpcFile(TASKS_DIR, data);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Workflow "${args.title}" submitted (${filename}). The host will validate and start execution.`,
          },
        ],
      };
    },
  );
}

// ── wiki_synthesis ───────────────────────────────────────────────
if (canStartWorkflow) {
  server.registerTool(
    'wiki_synthesis',
    {
      description:
        'Start a spec-driven wiki synthesis or update workflow. Provide domain and wiki_output_dir — base_file is auto-discovered from the domain name if omitted. Ask the user for wiki_output_dir if not specified.',
      inputSchema: {
        domain: z.string().describe('Domain name (e.g. "안전성검토", "첨가물정보제출")'),
        wiki_output_dir: z
          .string()
          .describe('Absolute host path to the Obsidian folder where the finished wiki note will be saved (e.g. /Users/planee/Documents/Mywork/3. Resource/LLM Knowledge Base/wiki)'),
        base_file: z
          .string()
          .optional()
          .describe('Optional: path to .base index file. Auto-discovered if omitted.'),
        filter: z
          .string()
          .optional()
          .describe('Optional glob filter pattern for documents'),
        vault_root: z
          .string()
          .optional()
          .describe('Obsidian vault root host path. Defaults to /Users/planee/Documents/Mywork'),
        model: z
          .string()
          .optional()
          .describe('LLM model override (default: gpt-5.4)'),
      },
    },
    async (args) => {
      const DEFAULT_VAULT_HOST_PATH = '/Users/planee/Documents/Mywork';
      const rawVaultRoot = args.vault_root || DEFAULT_VAULT_HOST_PATH;
      const vaultRoot = normalizeVaultRoot(rawVaultRoot, DEFAULT_VAULT_HOST_PATH);

      const basePath = args.base_file || findFileByDomain(
        [
          '/workspace/extra/vault/3. Resource/LLM Knowledge Base/index',
          '/workspace/extra/obsidian-vault/3. Resource/LLM Knowledge Base/index',
        ],
        '.base',
        args.domain,
      );

      const qualityLoopConfig: Record<string, string> = {
        task: 'catalog.tasks.wiki.task.WikiTask',
        domain: args.domain,
        vault_root: vaultRoot,
        wiki_output_dir: args.wiki_output_dir,
      };
      if (basePath) qualityLoopConfig.base = toHostPath(basePath, vaultRoot);
      if (args.filter) qualityLoopConfig.filter = args.filter;
      if (args.model) qualityLoopConfig.model = args.model;

      const data = {
        type: 'start_workflow',
        chatJid,
        groupFolder,
        title: `Wiki Synthesis: ${args.domain}`,
        steps: [
          {
            assignee: groupFolder,
            goal: `${args.domain} 도메인의 wiki note를 raw 문서에서 합성`,
            acceptance_criteria: [JSON.stringify(qualityLoopConfig)],
            constraints: ['Archive 폴더 문서만 대상', 'hallucination 금지'],
            stage_id: 'execute',
          },
        ],
        timestamp: new Date().toISOString(),
      };

      const filename = writeIpcFile(TASKS_DIR, data);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Wiki synthesis workflow started for domain "${args.domain}" (${filename}). The quality-loop engine will run and write results to ${args.wiki_output_dir}.`,
          },
        ],
      };
    },
  );
}

// Safe read-only shell tool
const SAFE_SHELL_ALLOWED = /^(python3?|ls|find|cat|head|tail|grep|echo|which|wc|stat|file)\b/;
const SAFE_SHELL_BLOCKED = /\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bdd\b|\bmkfs\b|\btruncate\b|>|>>|\btee\b|\bsqlite3\b|\bsql\b|\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i;

server.registerTool(
  'safe_shell',
  {
    description:
      'Run a read-only shell command for exploration (ls, cat, find, python --help, grep, etc.). Destructive commands (rm, mv, chmod, redirects) are blocked.',
    inputSchema: {
      command: z.string().describe('Shell command to run (read-only operations only)'),
    },
  },
  async (args) => {
    const cmd = args.command.trim();
    if (!SAFE_SHELL_ALLOWED.test(cmd)) {
      return {
        content: [{ type: 'text' as const, text: `Error: command not in allowlist. Permitted: python, ls, find, cat, head, tail, grep, echo, which, wc, stat, file` }],
      };
    }
    if (SAFE_SHELL_BLOCKED.test(cmd)) {
      return {
        content: [{ type: 'text' as const, text: `Error: destructive operation not allowed` }],
      };
    }
    return new Promise((resolve) => {
      execFile('bash', ['-c', cmd], { timeout: 10_000, maxBuffer: 256 * 1024 }, (_err, stdout, stderr) => {
        const output = (stdout + (stderr ? `\nstderr: ${stderr}` : '')).trim();
        resolve({ content: [{ type: 'text' as const, text: output || '(no output)' }] });
      });
    });
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
