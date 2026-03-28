export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

/** A secondary agent (team member) that the primary agent can delegate to. */
export interface SubAgentConfig {
  /** Display name for this agent (e.g., "gpt", "kimi"). Used in ask_agent MCP tool. */
  name: string;
  /** Agent backend type. */
  backend: 'claude' | 'opencode' | 'zai' | 'openai-compat' | 'openai';
  /** Model identifier (e.g., "gpt-4o", "kimi-k2.5"). */
  model?: string;
  /** API key. Falls back to the corresponding global config if omitted. */
  apiKey?: string;
  /** Base URL for the API endpoint (openai-compat/openai). */
  baseUrl?: string;
  /** Short role description shown to the primary agent (e.g., "Code reviewer"). */
  role?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  /** Per-group agent backend override. Falls back to global AGENT_BACKEND. */
  backend?: 'claude' | 'opencode' | 'zai' | 'openai-compat' | 'openai';
  /** Whitelist of tool names this group can use. Undefined = all tools. */
  allowedTools?: string[];
  /** Per-group model override (e.g. "glm-4.7", "kimi-k2.5"). */
  model?: string;
  /** Per-group API key override. */
  apiKey?: string;
  /** Per-group base URL override (for openai-compat). */
  baseUrl?: string;
  /** Optional display name for the lead agent when sending persona messages. */
  leadSender?: string;
  /** Map visible speaker names to real Discord bot labels (e.g. { "키미": "kimi" }). */
  senderBotMap?: Record<string, string>;
  /** How Discord persona messages should be delivered. */
  personaMode?: 'hybrid' | 'bot_only';
  /** Sub-agents (team members) the primary agent can delegate to via ask_agent. */
  subAgents?: SubAgentConfig[];
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Workflow orchestration ---

export type WorkflowStatus =
  | 'pending_confirmation'
  | 'awaiting_confirmation'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkflowStepStatus =
  | 'pending'
  | 'awaiting_confirmation'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface WorkflowPlanStep {
  step_index: number;
  assignee: string; // group folder (e.g. "discord_workshop")
  goal: string;
  acceptance_criteria?: string[];
  constraints?: string[];
}

export interface WorkflowRun {
  id: string;
  title: string;
  source_group_folder: string;
  source_chat_jid: string;
  participants: string | null; // JSON array of assignee group folders
  status: WorkflowStatus;
  current_step_index: number;
  plan_json: string | null; // JSON array of WorkflowPlanStep
  discord_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStepRun {
  id: string;
  workflow_id: string;
  step_index: number;
  step_group: string | null; // reserved for parallel steps
  assignee_group_folder: string;
  assignee_chat_jid: string;
  goal: string;
  acceptance_criteria: string | null; // JSON array
  constraints: string | null; // JSON array
  status: WorkflowStepStatus;
  claimed_at: string | null;
  lease_expires_at: string | null;
  result_summary: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    opts?: { sender?: string },
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: workflow thread support (Discord).
  createThread?(jid: string, name: string): Promise<string | null>;
  sendToThread?(threadId: string, text: string): Promise<void>;
  editMessage?(channelId: string, messageId: string, newText: string): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
