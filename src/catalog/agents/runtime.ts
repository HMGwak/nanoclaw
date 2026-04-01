import { RegisteredGroup, SubAgentConfig } from '../../types.js';
import {
  resolveGroupImportedSubAgents,
  resolveGroupLeadSender,
  resolveGroupSpeakerNames,
  resolveServiceDeployment,
} from '../../services/index.js';
import { ResolvedAgentRuntimeSpec } from '../../services/types.js';

export interface AgentTeamSpec {
  lead: ResolvedAgentRuntimeSpec | null;
  teammates: ResolvedAgentRuntimeSpec[];
  teammateConfigs: ResolvedAgentRuntimeSpec[];
  importedSubAgents: SubAgentConfig[];
  delegateConfigs: SubAgentConfig[];
  speakerNames: string[];
}

function buildTeammateSystemPrompt(
  teammate: ResolvedAgentRuntimeSpec,
  departmentPrompt: string | null,
): string | undefined {
  const parts = [
    teammate.capabilityPrompt,
    teammate.personaPrompt,
    departmentPrompt,
  ].filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

export function buildGroupAgentTeam(group: RegisteredGroup): AgentTeamSpec {
  const deployment = resolveServiceDeployment(group);
  const teammateConfigs =
    deployment?.teammates.map((teammate) => ({
      ...teammate,
      systemPrompt: buildTeammateSystemPrompt(
        teammate,
        deployment.departmentPrompt,
      ),
    })) || [];
  const importedSubAgents = resolveGroupImportedSubAgents(group);

  return {
    lead: deployment?.lead || null,
    teammates: deployment?.teammates || [],
    teammateConfigs,
    importedSubAgents,
    delegateConfigs: [...teammateConfigs, ...importedSubAgents],
    speakerNames: resolveGroupSpeakerNames(group),
  };
}

export function getConfiguredSpeakerNames(group: RegisteredGroup): string[] {
  return resolveGroupSpeakerNames(group);
}

export function getLeadSenderName(group: RegisteredGroup): string {
  return resolveGroupLeadSender(group);
}
