/** A secondary agent entry passed from the host. */
export interface SubAgentEntry {
  name: string;
  backend: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  role?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

export interface InstructionLayer {
  id: string;
  content: string;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  instructionLayers?: InstructionLayer[];
  /** Sub-agents available via ask_agent MCP tool. */
  subAgents?: SubAgentEntry[];
  /** Shared skill docs relevant to this runtime. */
  skillIds?: string[];
  /** Extra directories mounted under /workspace/extra for this run. */
  mountedDirectories?: Array<{
    path: string;
    readonly: boolean;
  }>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AgentTurnResult {
  newSessionId?: string;
  lastAssistantCursor?: string;
  closedDuringQuery: boolean;
}

export interface AgentTurnContext {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  mcpServerPath: string;
  containerInput: ContainerInput;
  agentEnv: Record<string, string | undefined>;
  emitOutput: (output: ContainerOutput) => void;
  log: (message: string) => void;
  drainIpcInput: () => string[];
  shouldClose: () => boolean;
  waitForIpcMessage: () => Promise<string | null>;
}

export interface AgentProvider {
  name: string;
  runTurn(context: AgentTurnContext): Promise<AgentTurnResult>;
}
