export interface SdkProfileSpec {
  id: string;
  backend: 'claude' | 'opencode' | 'zai' | 'openai-compat' | 'openai';
  model?: string;
  baseUrl?: string;
  apiKeySource?: string;
}
