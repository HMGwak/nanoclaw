import { SdkProfileSpec } from './types.js';

const SDK_PROFILES: Record<string, SdkProfileSpec> = {
  'workshop-teamleader-gpt': {
    id: 'workshop-teamleader-gpt',
    backend: 'openai',
    model: 'gpt-5.4',
  },
  'workshop-teammate-kimi': {
    id: 'workshop-teammate-kimi',
    backend: 'opencode',
    model: 'opencode-go/kimi-k2.5',
  },
  'planning-lead-gpt': {
    id: 'planning-lead-gpt',
    backend: 'openai',
    model: 'gpt-5.4',
  },
  'secretary-lead-gpt': {
    id: 'secretary-lead-gpt',
    backend: 'openai',
    model: 'gpt-5.4',
  },
};

export function getSdkProfileSpec(id: string): SdkProfileSpec | null {
  return SDK_PROFILES[id] || null;
}

export function listSdkProfileSpecs(): SdkProfileSpec[] {
  return Object.values(SDK_PROFILES);
}
