export type DebateModeId =
  | 'standard'
  | 'oxford'
  | 'advocate'
  | 'socratic'
  | 'delphi'
  | 'brainstorm'
  | 'tradeoff';

export type DebateConsensusPolicy =
  | 'lead_final_judgment'
  | 'majority_with_minority'
  | 'unanimous';

export type DebateTurnStrategy =
  | 'round_robin'
  | 'structured_pro_con'
  | 'challenge_and_rebuttal'
  | 'question_driven'
  | 'iterative_convergence'
  | 'diverge_then_converge'
  | 'criteria_scoring';

export type DebateEvidenceType =
  | 'web'
  | 'file'
  | 'memory'
  | 'karpathy_loop_brief';

export interface DebatePostRoundCollectionSpec {
  enabled: boolean;
  triggerAfterRound: number;
  guidance: string;
}

export interface DebateRoleSpec {
  id: string;
  description: string;
  stance?: 'pro' | 'con' | 'neutral';
}

export interface DebateProtocolSpec {
  id: DebateModeId;
  title: string;
  turnStrategy: DebateTurnStrategy;
  defaultRounds: number;
  consensusPolicy: DebateConsensusPolicy;
  postRoundCollection: DebatePostRoundCollectionSpec;
  requiredRoleSlots: DebateRoleSpec[];
  outputSections: Array<
    | 'round_summaries'
    | 'final_judgment'
    | 'rationale'
    | 'minority_note'
    | 'post_round_collection'
    | 'followups'
  >;
  sourceModuleIds?: string[];
}

export interface DebateModeSpec {
  id: DebateModeId;
  title: string;
  description: string;
  protocolId: DebateModeId;
  sourceModuleIds?: string[];
}

export interface DebateEvidencePack {
  type: DebateEvidenceType;
  ref: string;
  title?: string;
  summary?: string;
}

export interface DebateInputContract {
  topic: string;
  modeHint: DebateModeId | null;
  roundsHint: number | null;
  participantsHint: string[] | null;
  backgroundKnowledgeRefs: string[];
  evidencePacks: DebateEvidencePack[];
}

export interface DebateOutputContract {
  roundSummaries: string[];
  finalJudgment: string;
  rationale: string;
  minorityNote: string | null;
  postRoundCollectionSummary: string | null;
  followups: string[];
}

export interface DebateServiceOverlayContract {
  participantIds: string[];
  roleAssignments: Record<string, string>;
  roundOverride: number | null;
  backgroundKnowledgeRefs: string[];
}

export interface DebateIntentSeed {
  isDebateIntent: boolean;
  modeHint: DebateModeId | null;
  roundsHint: number | null;
  topic: string | null;
}
