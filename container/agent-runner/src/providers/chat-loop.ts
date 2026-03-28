import OpenAI from 'openai';

import { executeTool } from '../tools/shared.js';

interface LoopContext {
  log: (message: string) => void;
  env: Record<string, string | undefined>;
}

interface RunChatLoopOptions {
  client: OpenAI;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  loopContext: LoopContext;
  maxLoops: number;
}

export async function runChatCompletionLoop(
  options: RunChatLoopOptions,
): Promise<string> {
  const { client, model, messages, tools, loopContext, maxLoops } = options;
  let assistantText = '';

  for (let loop = 0; loop < maxLoops; loop++) {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
    });

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
      const output = await executeTool(fn.name, fn.arguments, loopContext);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: output,
      });
    }
  }

  return assistantText;
}
