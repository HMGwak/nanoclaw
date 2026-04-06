import { RegisteredGroup } from '../../types.js';
import {
  getDiscordGroupBindingForGroup,
  listDiscordGroupBindings,
} from './bindings/groups.js';
import { DiscordServiceDeploymentSpec } from './types.js';

function toDeploymentSpec(
  binding: ReturnType<typeof getDiscordGroupBindingForGroup>,
): DiscordServiceDeploymentSpec | null {
  if (!binding) return null;
  return {
    id: binding.id,
    departmentId: binding.departmentId,
    botLabel: binding.botLabel,
    canonicalGroupFolder: binding.canonicalGroupFolder,
    groupFolders: [...binding.groupFolders],
    leadPersonnelId: binding.leadPersonnelId,
    teammatePersonnelIds: [...binding.teammatePersonnelIds],
    flowIds: [...binding.flowIds],
    senderBotMap: binding.senderBotMap
      ? { ...binding.senderBotMap }
      : undefined,
    personaMode: binding.personaMode,
    responsePolicy: binding.responsePolicy,
    requiresTrigger: binding.requiresTrigger,
    canStartWorkflow: binding.canStartWorkflow,
    defaultAdditionalMounts: binding.defaultAdditionalMounts,
  };
}

export function getDiscordDeploymentForGroup(
  group: RegisteredGroup | string,
): DiscordServiceDeploymentSpec | null {
  return toDeploymentSpec(getDiscordGroupBindingForGroup(group));
}

export function listDiscordDeployments(): DiscordServiceDeploymentSpec[] {
  return listDiscordGroupBindings()
    .map((binding) => toDeploymentSpec(binding))
    .filter(
      (deployment): deployment is DiscordServiceDeploymentSpec =>
        deployment !== null,
    );
}
