import { getAgentSpec } from '../catalog/agents/index.js';
import { getSdkProfileSpec } from '../catalog/sdk-profiles/index.js';
import { getToolsetSpec } from '../catalog/toolsets/index.js';
import { RegisteredGroup } from '../types.js';
import { getDiscordDeploymentForGroup } from './discord/deployments.js';
import { ResolvedAgentRuntimeSpec, ResolvedServiceDeployment } from './types.js';

function unique(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function mergeAllowedTools(toolsetIds: string[]): string[] | undefined {
  const all = toolsetIds
    .map((toolsetId) => getToolsetSpec(toolsetId))
    .filter((spec): spec is NonNullable<typeof spec> => spec !== null)
    .flatMap((spec) => spec.allowedTools ?? []);
  return all.length > 0 ? unique(all) : undefined;
}

function resolveAgentRuntime(agentId: string): ResolvedAgentRuntimeSpec | null {
  const agent = getAgentSpec(agentId);
  if (!agent) return null;
  const profile = getSdkProfileSpec(agent.baseProfileId);
  if (!profile) return null;

  return {
    id: agent.id,
    name: agent.displayName,
    displayName: agent.displayName,
    backend: profile.backend,
    model: profile.model,
    baseUrl: profile.baseUrl,
    role: agent.role,
    allowedTools: mergeAllowedTools(agent.defaultToolsetIds),
    toolsetIds: [...agent.defaultToolsetIds],
    flowIds: [...agent.defaultFlowIds],
  };
}

export function resolveServiceDeployment(
  group: RegisteredGroup,
): ResolvedServiceDeployment | null {
  const discordDeployment = getDiscordDeploymentForGroup(group);
  if (!discordDeployment) return null;

  const lead = resolveAgentRuntime(discordDeployment.leadAgentId);
  const teammates = discordDeployment.teammateAgentIds
    .map((agentId) => resolveAgentRuntime(agentId))
    .filter((agent): agent is ResolvedAgentRuntimeSpec => agent !== null);

  const speakerNames = unique(
    [lead?.displayName || group.name, ...teammates.map((agent) => agent.displayName)].filter(
      Boolean,
    ) as string[],
  );

  return {
    id: discordDeployment.id,
    service: 'discord',
    group,
    lead,
    teammates,
    speakerNames,
    senderBotMap: { ...(discordDeployment.senderBotMap || {}) },
    personaMode: discordDeployment.personaMode || 'hybrid',
    flowIds: [...discordDeployment.flowIds],
    canStartWorkflow: discordDeployment.canStartWorkflow === true,
    containerRuntime: {
      additionalMounts: group.containerConfig?.additionalMounts,
      timeout: group.containerConfig?.timeout,
      backend: group.containerConfig?.backend,
      allowedTools: group.containerConfig?.allowedTools,
      model: group.containerConfig?.model,
      apiKey: group.containerConfig?.apiKey,
      baseUrl: group.containerConfig?.baseUrl,
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

export function canStartWorkflowFromGroup(
  sourceGroup: string,
  isMain: boolean,
): boolean {
  if (isMain) return true;
  const deployment = getDiscordDeploymentForGroup(sourceGroup);
  return deployment?.canStartWorkflow === true;
}
