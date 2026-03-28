export interface FlowStageSpec {
  id: string;
  title: string;
  description: string;
}

export interface FlowSpec {
  id: string;
  title: string;
  description: string;
  stages: FlowStageSpec[];
  sourceModuleIds?: string[];
}
