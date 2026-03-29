import { SdkProfileSpec } from './types.js';

const SDK_PROFILES: Record<string, SdkProfileSpec> = {
  openai_gpt54: {
    id: 'openai_gpt54',
    backend: 'openai',
    model: 'gpt-5.4',
  },
  opencode_kimi_k25: {
    id: 'opencode_kimi_k25',
    backend: 'opencode',
    model: 'opencode-go/kimi-k2.5',
  },
};

export function getSdkProfileSpec(id: string): SdkProfileSpec | null {
  return SDK_PROFILES[id] || null;
}

export function listSdkProfileSpecs(): SdkProfileSpec[] {
  return Object.values(SDK_PROFILES);
}
