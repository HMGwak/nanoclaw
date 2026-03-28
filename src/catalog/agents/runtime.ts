import { RegisteredGroup } from '../../types.js';
import {
  resolveGroupLeadSender,
  resolveGroupSpeakerNames,
  resolveServiceDeployment,
} from '../../services/index.js';
import { ResolvedAgentRuntimeSpec } from '../../services/types.js';

export interface AgentTeamSpec {
  lead: ResolvedAgentRuntimeSpec | null;
  teammates: ResolvedAgentRuntimeSpec[];
  teammateConfigs: ResolvedAgentRuntimeSpec[];
  speakerNames: string[];
}

export function buildGroupAgentTeam(group: RegisteredGroup): AgentTeamSpec {
  const deployment = resolveServiceDeployment(group);
  return {
    lead: deployment?.lead || null,
    teammates: deployment?.teammates || [],
    teammateConfigs: deployment?.teammates || [],
    speakerNames: resolveGroupSpeakerNames(group),
  };
}

export function getConfiguredSpeakerNames(group: RegisteredGroup): string[] {
  return resolveGroupSpeakerNames(group);
}

export function getLeadSenderName(group: RegisteredGroup): string {
  return resolveGroupLeadSender(group);
}
