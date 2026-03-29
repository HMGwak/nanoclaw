import { getAgentSpec } from '../catalog/agents/index.js';
import { getSdkProfileSpec } from '../catalog/sdk-profiles/index.js';
import { getToolsetSpec } from '../catalog/toolsets/index.js';
import { BrowserToolPolicySpec } from '../catalog/toolsets/types.js';
import { RegisteredGroup } from '../types.js';
import { getDiscordDepartmentSpec } from './discord/departments/index.js';
import { getDiscordDeploymentForGroup } from './discord/deployments.js';
import { getDiscordPersonnelSpec } from './discord/resources/personnel.js';
import { getDiscordPersonnelPrompt } from './discord/resources/prompts.js';
import { getDiscordLocalToolsetSpec } from './discord/resources/toolsets.js';
import {
  ResolvedAgentRuntimeSpec,
  ResolvedServiceDeployment,
} from './types.js';

function unique(values: string[]): string[] {
  return values.filter(
    (value, index) => value && values.indexOf(value) === index,
  );
}

const POLICY_AGENT_BROWSER_TOOLS = [
  'browse_open',
  'browse_click',
  'browse_fill',
  'browse_select',
  'browse_snapshot',
  'browse_screenshot',
  'browse_get_text',
  'browse_press',
  'browse_close',
];

const POLICY_PLAYWRIGHT_TOOLS = [
  'playwright_open',
  'playwright_screenshot',
  'playwright_execute',
  'playwright_extract',
  'playwright_pdf',
];

function mergeAllowedToolsFromSets(
  allowedToolSets: Array<string[] | null | undefined>,
): string[] | undefined {
  const hasUnrestricted = allowedToolSets.some((entry) => entry === null);
  if (hasUnrestricted) return undefined;
  const merged = unique(allowedToolSets.flatMap((entry) => entry || []));
  return merged.length > 0 ? merged : undefined;
}

function mergeBrowserPolicyFromSets(
  policies: Array<BrowserToolPolicySpec | undefined>,
): BrowserToolPolicySpec | undefined {
  const candidates = policies.filter(
    (policy): policy is BrowserToolPolicySpec => Boolean(policy),
  );
  if (candidates.length === 0) return undefined;
  return (
    candidates.find((policy) => policy.enforcement === 'hard') || candidates[0]
  );
}

function resolvePolicyRequiredTools(
  policy: BrowserToolPolicySpec | undefined,
): string[] {
  if (!policy) return [];
  const required: string[] = [];
  for (const stage of policy.chain) {
    if (stage === 'cloudflare_fetch') {
      required.push('cloudflare_fetch');
      continue;
    }
    if (stage === 'agent_browser') {
      required.push(...POLICY_AGENT_BROWSER_TOOLS);
      continue;
    }
    if (stage === 'playwright') {
      required.push(...POLICY_PLAYWRIGHT_TOOLS);
    }
  }
  return unique([...(policy.supplementalTools || []), ...required]);
}

function resolveAgentRuntime(
  personnelId: string,
): ResolvedAgentRuntimeSpec | null {
  const personnel = getDiscordPersonnelSpec(personnelId);
  if (!personnel) return null;

  const agent = getAgentSpec(personnel.catalogAgentId);
  if (!agent) return null;

  const profile = getSdkProfileSpec(agent.baseProfileId);
  if (!profile) return null;
  const personaPrompt = getDiscordPersonnelPrompt(personnel.promptId);

  const localToolsets = personnel.localToolsetIds
    .map((toolsetId) => getDiscordLocalToolsetSpec(toolsetId))
    .filter((spec): spec is NonNullable<typeof spec> => spec !== null);

  const importedGlobalToolsetIds = unique(
    localToolsets.flatMap((toolset) => toolset.importedGlobalToolsetIds),
  );

  const globalToolsetIds = unique([
    ...agent.defaultToolsetIds,
    ...importedGlobalToolsetIds,
  ]);

  const globalToolsets = globalToolsetIds
    .map((toolsetId) => getToolsetSpec(toolsetId))
    .filter((spec): spec is NonNullable<typeof spec> => spec !== null);

  const allowedTools = mergeAllowedToolsFromSets([
    ...globalToolsets.map((toolset) => toolset.allowedTools),
    ...localToolsets.map((toolset) => toolset.allowedTools),
  ]);
  const browserPolicy = mergeBrowserPolicyFromSets([
    ...globalToolsets.map((toolset) => toolset.browserPolicy),
    ...localToolsets.map((toolset) => toolset.browserPolicy),
  ]);

  const flowIds = unique([...agent.defaultFlowIds, ...personnel.flowIds]);

  return {
    id: personnel.id,
    name: personnel.displayName,
    displayName: personnel.displayName,
    backend: profile.backend,
    model: profile.model,
    baseUrl: profile.baseUrl,
    role: personnel.role || agent.role,
    capabilityPrompt: agent.capabilityPrompt || null,
    personaPrompt,
    allowedTools,
    toolsetIds: [...globalToolsetIds, ...personnel.localToolsetIds],
    flowIds,
    browserPolicy,
  };
}

export function resolveServiceDeployment(
  group: RegisteredGroup,
): ResolvedServiceDeployment | null {
  const discordDeployment = getDiscordDeploymentForGroup(group);
  if (!discordDeployment) return null;

  const lead = resolveAgentRuntime(discordDeployment.leadPersonnelId);
  const teammates = discordDeployment.teammatePersonnelIds
    .map((personnelId) => resolveAgentRuntime(personnelId))
    .filter((agent): agent is ResolvedAgentRuntimeSpec => agent !== null);
  const department = getDiscordDepartmentSpec(discordDeployment.departmentId);
  const personnel = unique(
    [lead, ...teammates].filter(Boolean).map((agent) => agent!.id),
  )
    .map(
      (personnelId) =>
        [lead, ...teammates].find((agent) => agent?.id === personnelId) || null,
    )
    .filter((agent): agent is ResolvedAgentRuntimeSpec => agent !== null);

  const speakerNames = unique(
    [
      lead?.displayName || group.name,
      ...teammates.map((agent) => agent.displayName),
    ].filter(Boolean) as string[],
  );
  const senderBotMap: Record<string, string> = {
    ...(discordDeployment.senderBotMap || {}),
  };
  if (lead?.displayName && discordDeployment.botLabel) {
    senderBotMap[lead.displayName] = discordDeployment.botLabel;
  }

  const baseAllowedTools =
    group.containerConfig?.allowedTools || lead?.allowedTools;
  const policyRequiredTools = resolvePolicyRequiredTools(lead?.browserPolicy);
  const runtimeAllowedTools = baseAllowedTools
    ? unique([...baseAllowedTools, ...policyRequiredTools])
    : undefined;

  return {
    id: discordDeployment.id,
    service: 'discord',
    departmentId: discordDeployment.departmentId,
    botLabel: discordDeployment.botLabel,
    canonicalGroupFolder: discordDeployment.canonicalGroupFolder,
    department: {
      id: department.id,
      displayName: department.displayName,
      prompt: department.prompt,
      handoffTemplate: department.handoffTemplate,
    },
    group,
    lead,
    leadCapabilityPrompt: lead?.capabilityPrompt || null,
    leadPrompt: lead?.personaPrompt || null,
    departmentPrompt: department.prompt,
    teammates,
    personnel,
    speakerNames,
    senderBotMap,
    personaMode: discordDeployment.personaMode || 'hybrid',
    responsePolicy: discordDeployment.responsePolicy || 'always',
    requiresTrigger: discordDeployment.requiresTrigger !== false,
    flowIds: [...discordDeployment.flowIds],
    canStartWorkflow: discordDeployment.canStartWorkflow === true,
    containerRuntime: {
      additionalMounts: group.containerConfig?.additionalMounts,
      timeout: group.containerConfig?.timeout,
      backend: group.containerConfig?.backend,
      allowedTools: runtimeAllowedTools,
      model: group.containerConfig?.model,
      apiKey: group.containerConfig?.apiKey,
      baseUrl: group.containerConfig?.baseUrl,
      browserPolicy: lead?.browserPolicy,
    },
  };
}

export function resolveGroupSpeakerNames(group: RegisteredGroup): string[] {
  return resolveServiceDeployment(group)?.speakerNames || [group.name];
}

export function resolveGroupLeadSender(group: RegisteredGroup): string {
  return resolveServiceDeployment(group)?.lead?.displayName || group.name;
}

export function resolveGroupPersonaBotLabel(
  group: RegisteredGroup | undefined,
  sender?: string,
): string | undefined {
  const trimmedSender = sender?.trim();
  if (!group || !trimmedSender) return undefined;
  return resolveServiceDeployment(group)?.senderBotMap?.[trimmedSender];
}

export function resolveGroupPersonaMode(
  group: RegisteredGroup | undefined,
): 'hybrid' | 'bot_only' {
  if (!group) return 'hybrid';
  return resolveServiceDeployment(group)?.personaMode || 'hybrid';
}

function parseDiscordBotLabelFromJid(chatJid: string): string | null {
  const parts = chatJid.replace(/^dc:/, '').split(':');
  if (parts.length < 2) return null;
  const label = parts[1]?.trim().toLowerCase();
  return label || null;
}

export function resolveGroupTargetSender(
  group: RegisteredGroup,
  chatJid: string,
): string {
  const deployment = resolveServiceDeployment(group);
  const fallback = deployment?.lead?.displayName || group.name;
  if (!deployment) return fallback;

  const botLabel = parseDiscordBotLabelFromJid(chatJid);
  if (!botLabel || botLabel === 'primary') return fallback;

  for (const [senderName, mappedLabel] of Object.entries(
    deployment.senderBotMap,
  )) {
    if (mappedLabel.trim().toLowerCase() === botLabel) {
      return senderName;
    }
  }

  return fallback;
}

export function shouldEnforceSingleSender(group: RegisteredGroup): boolean {
  const deployment = resolveServiceDeployment(group);
  if (!deployment) return false;
  return (
    deployment.personaMode === 'bot_only' &&
    Object.keys(deployment.senderBotMap).length > 0
  );
}

export function canStartWorkflowFromGroup(sourceGroup: string): boolean {
  const deployment = getDiscordDeploymentForGroup(sourceGroup);
  return deployment?.canStartWorkflow === true;
}
