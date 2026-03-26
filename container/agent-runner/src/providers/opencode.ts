import crypto from 'crypto';

import {
  AgentProvider,
  AgentTurnContext,
  AgentTurnResult,
} from '../types.js';

const DEFAULT_OPENCODE_MODEL = 'opencode-go/kimi-k2.5';
const OPENCODE_PROMPT_TIMEOUT_MS = 300_000;

// Singleton: keep one server + client alive across turns
let cachedClient: unknown = null;

async function getOrCreateClient(
  model: string,
  log: (msg: string) => void,
): Promise<unknown> {
  if (cachedClient) {
    log('Reusing existing OpenCode server');
    return cachedClient;
  }

  const { createOpencode } = await import('@opencode-ai/sdk');

  log('Starting OpenCode server via SDK...');

  const { client } = await createOpencode({
    config: {
      model,
    },
    timeout: 30000,
  });

  log('OpenCode server started via SDK');
  cachedClient = client;
  return client;
}

async function runOpencodeTurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const sessionId = context.sessionId || crypto.randomUUID();
  const model = context.agentEnv.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL;
  const apiKey = context.agentEnv.OPENCODE_API_KEY || '';

  context.log(
    `Running OpenCode turn (session: ${sessionId}, model: ${model})`,
  );

  if (!apiKey) {
    const errorMsg = 'OPENCODE_API_KEY is not set';
    context.log(`Error: ${errorMsg}`);
    context.emitOutput({ status: 'error', result: null, error: errorMsg });
    return { closedDuringQuery: false };
  }

  try {
    const client = await getOrCreateClient(model, context.log) as {
      session: {
        create: () => Promise<{ data?: { id?: string } }>;
        prompt: (opts: {
          path: { id: string };
          body: { parts: Array<{ type: string; text: string }> };
        }) => Promise<{ data?: unknown }>;
      };
    };

    // Create a session
    const sessionRes = await client.session.create();
    const opencodeSessionId = sessionRes.data?.id;

    if (!opencodeSessionId) {
      throw new Error(
        `OpenCode session creation returned no id: ${JSON.stringify(sessionRes)}`,
      );
    }

    context.log(`OpenCode session created: ${opencodeSessionId}`);

    // Send prompt
    const timer = setTimeout(() => {
      context.log('OpenCode prompt timed out');
    }, OPENCODE_PROMPT_TIMEOUT_MS);

    let resultText = '';
    try {
      const promptRes = await client.session.prompt({
        path: { id: opencodeSessionId },
        body: {
          parts: [{ type: 'text', text: context.prompt }],
        },
      });

      clearTimeout(timer);

      // Extract text from response
      const data = promptRes.data;
      if (data) {
        // Try parts array
        const parts = (data as { parts?: Array<{ type?: string; text?: string; content?: string }> }).parts;
        if (parts && Array.isArray(parts)) {
          resultText = parts
            .filter((p) => p.type === 'text' || p.text || p.content)
            .map((p) => p.text || p.content || '')
            .join('\n');
        }

        // Try message content
        if (!resultText) {
          const message = (data as { message?: { content?: string | Array<{ type: string; text?: string }> } }).message;
          if (message?.content) {
            if (typeof message.content === 'string') {
              resultText = message.content;
            } else if (Array.isArray(message.content)) {
              resultText = message.content
                .filter((c) => c.type === 'text' && c.text)
                .map((c) => c.text!)
                .join('\n');
            }
          }
        }

        // Fallback: stringify the response
        if (!resultText && data) {
          resultText = JSON.stringify(data);
        }
      }
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    context.log(`OpenCode response received (${resultText.length} chars)`);

    context.emitOutput({
      status: 'success',
      result: resultText || null,
      newSessionId: sessionId,
    });

    return {
      newSessionId: sessionId,
      closedDuringQuery: false,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    context.log(`OpenCode error: ${errorMsg}`);
    // Reset cached client on error so next turn tries fresh
    cachedClient = null;
    context.emitOutput({ status: 'error', result: null, error: errorMsg });
    return { closedDuringQuery: false };
  }
}

export const opencodeProvider: AgentProvider = {
  name: 'opencode',
  runTurn: runOpencodeTurn,
};
