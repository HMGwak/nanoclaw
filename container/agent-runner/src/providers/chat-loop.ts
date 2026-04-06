import OpenAI from 'openai';

import { executeTool } from '../tools/shared.js';

interface BrowserPolicyRuntime {
  id: string;
  enforcement: 'advisory' | 'hard';
  chain: Array<'cloudflare_fetch' | 'agent_browser' | 'playwright'>;
  supplementalTools?: string[];
}

interface BrowserPolicyState {
  cloudflareAttempted: boolean;
  agentBrowserAttempted: boolean;
}

interface LoopContext {
  log: (message: string) => void;
  env: Record<string, string | undefined>;
  chatJid?: string;
  groupFolder?: string;
  isMain?: boolean;
  emitText?: (text: string) => void;
}

interface RunChatLoopOptions {
  client: OpenAI;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  loopContext: LoopContext;
  maxLoops: number;
  completionTimeoutMs?: number;
}

const AGENT_BROWSER_TOOL_NAMES = new Set([
  'browse_open',
  'browse_click',
  'browse_fill',
  'browse_select',
  'browse_snapshot',
  'browse_screenshot',
  'browse_get_text',
  'browse_press',
  'browse_close',
]);

const PLAYWRIGHT_TOOL_NAMES = new Set([
  'playwright_open',
  'playwright_screenshot',
  'playwright_execute',
  'playwright_extract',
  'playwright_pdf',
]);

function parseBrowserPolicy(
  raw: string | undefined,
  log: (message: string) => void,
): BrowserPolicyRuntime | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as BrowserPolicyRuntime;
    if (!parsed?.id || !parsed?.enforcement || !Array.isArray(parsed?.chain)) {
      return null;
    }
    return parsed;
  } catch (err) {
    log(
      `Invalid NANOCLAW_BROWSER_POLICY: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function validateToolCallOrder(
  toolName: string,
  policy: BrowserPolicyRuntime | null,
  state: BrowserPolicyState,
): string | null {
  if (!policy || policy.enforcement !== 'hard') return null;
  if (toolName === 'cloudflare_fetch') return null;

  if (AGENT_BROWSER_TOOL_NAMES.has(toolName) && !state.cloudflareAttempted) {
    return [
      `Tool order policy (${policy.id}) violation.`,
      'Call cloudflare_fetch before any browse_* tool.',
      `Rejected tool: ${toolName}`,
    ].join(' ');
  }

  if (PLAYWRIGHT_TOOL_NAMES.has(toolName) && !state.agentBrowserAttempted) {
    return [
      `Tool order policy (${policy.id}) violation.`,
      'Call at least one browse_* tool before any playwright_* tool.',
      `Rejected tool: ${toolName}`,
    ].join(' ');
  }

  return null;
}

export async function runChatCompletionLoop(
  options: RunChatLoopOptions,
): Promise<string> {
  const {
    client,
    model,
    messages,
    tools,
    loopContext,
    maxLoops,
    completionTimeoutMs,
  } = options;
  let assistantText = '';
  const browserPolicy = parseBrowserPolicy(
    loopContext.env.NANOCLAW_BROWSER_POLICY,
    loopContext.log,
  );
  const browserPolicyState: BrowserPolicyState = {
    cloudflareAttempted: false,
    agentBrowserAttempted: false,
  };

  for (let loop = 0; loop < maxLoops; loop++) {
    const completionPromise = client.chat.completions.create({
      model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
    });
    const completion = completionTimeoutMs
      ? await Promise.race([
          completionPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(
                new Error(
                  `Chat completion timed out after ${completionTimeoutMs}ms (loop ${loop + 1}/${maxLoops})`,
                ),
              );
            }, completionTimeoutMs);
          }),
        ])
      : await completionPromise;

    const choice = completion.choices?.[0];
    if (!choice) {
      throw new Error('No choices in completion response');
    }

    loopContext.log(`loop=${loop + 1} finish_reason=${choice.finish_reason}`);

    if (choice.message.content) {
      assistantText = choice.message.content;
    }

    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      break;
    }

    messages.push(choice.message);
    loopContext.log(`${choice.message.tool_calls.length} tool call(s)`);

    for (const toolCall of choice.message.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const fn = toolCall.function;
      loopContext.log(`  tool: ${fn.name}(${fn.arguments.slice(0, 100)})`);
      const violation = validateToolCallOrder(
        fn.name,
        browserPolicy,
        browserPolicyState,
      );
      const output = violation
        ? JSON.stringify({
            ok: false,
            error: violation,
            policy: browserPolicy?.id || null,
          })
        : await executeTool(fn.name, fn.arguments, loopContext);

      if (!violation && fn.name === 'cloudflare_fetch') {
        browserPolicyState.cloudflareAttempted = true;
      }
      if (!violation && AGENT_BROWSER_TOOL_NAMES.has(fn.name)) {
        browserPolicyState.agentBrowserAttempted = true;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: output,
      });
    }
  }

  return assistantText;
}
