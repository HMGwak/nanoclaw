import {
  DebateInputContract,
  DebateIntentSeed,
  DebateModeId,
  DebateModeSpec,
  DebateOutputContract,
  DebateProtocolSpec,
  DebateServiceOverlayContract,
} from './types.js';

const DEBATE_PROTOCOL_SPECS: Record<DebateModeId, DebateProtocolSpec> = {
  standard: {
    id: 'standard',
    title: 'Standard',
    turnStrategy: 'round_robin',
    defaultRounds: 3,
    consensusPolicy: 'lead_final_judgment',
    requiredRoleSlots: [
      { id: 'speaker_a', description: 'Primary discussant' },
      { id: 'speaker_b', description: 'Counter discussant' },
    ],
    outputSections: [
      'round_summaries',
      'final_judgment',
      'rationale',
      'minority_note',
      'followups',
    ],
    sourceModuleIds: ['quorum_cli', 'autoresearch'],
  },
  oxford: {
    id: 'oxford',
    title: 'Oxford',
    turnStrategy: 'structured_pro_con',
    defaultRounds: 3,
    consensusPolicy: 'lead_final_judgment',
    requiredRoleSlots: [
      { id: 'proposer', description: 'Argues for the motion', stance: 'pro' },
      { id: 'opposer', description: 'Argues against the motion', stance: 'con' },
      { id: 'adjudicator', description: 'Final judge', stance: 'neutral' },
    ],
    outputSections: [
      'round_summaries',
      'final_judgment',
      'rationale',
      'minority_note',
      'followups',
    ],
    sourceModuleIds: ['quorum_cli', 'autoresearch'],
  },
  advocate: {
    id: 'advocate',
    title: 'Advocate',
    turnStrategy: 'challenge_and_rebuttal',
    defaultRounds: 3,
    consensusPolicy: 'lead_final_judgment',
    requiredRoleSlots: [
      { id: 'defender', description: 'Defends the working direction' },
      { id: 'advocate', description: 'Challenges assumptions aggressively' },
    ],
    outputSections: [
      'round_summaries',
      'final_judgment',
      'rationale',
      'minority_note',
      'followups',
    ],
    sourceModuleIds: ['quorum_cli', 'autoresearch'],
  },
  socratic: {
    id: 'socratic',
    title: 'Socratic',
    turnStrategy: 'question_driven',
    defaultRounds: 4,
    consensusPolicy: 'lead_final_judgment',
    requiredRoleSlots: [
      { id: 'questioner', description: 'Asks probing questions' },
      { id: 'respondent', description: 'Answers and refines claims' },
    ],
    outputSections: [
      'round_summaries',
      'final_judgment',
      'rationale',
      'minority_note',
      'followups',
    ],
    sourceModuleIds: ['quorum_cli', 'autoresearch'],
  },
  delphi: {
    id: 'delphi',
    title: 'Delphi',
    turnStrategy: 'iterative_convergence',
    defaultRounds: 3,
    consensusPolicy: 'lead_final_judgment',
    requiredRoleSlots: [
      { id: 'estimator_a', description: 'Provides estimate pass A' },
      { id: 'estimator_b', description: 'Provides estimate pass B' },
      { id: 'synthesizer', description: 'Merges estimates and revisions' },
    ],
    outputSections: [
      'round_summaries',
      'final_judgment',
      'rationale',
      'minority_note',
      'followups',
    ],
    sourceModuleIds: ['quorum_cli', 'autoresearch'],
  },
  brainstorm: {
    id: 'brainstorm',
    title: 'Brainstorm',
    turnStrategy: 'diverge_then_converge',
    defaultRounds: 3,
    consensusPolicy: 'lead_final_judgment',
    requiredRoleSlots: [
      { id: 'ideator_a', description: 'Generates ideas quickly' },
      { id: 'ideator_b', description: 'Generates contrasting ideas quickly' },
      { id: 'curator', description: 'Curates and clusters ideas' },
    ],
    outputSections: [
      'round_summaries',
      'final_judgment',
      'rationale',
      'minority_note',
      'followups',
    ],
    sourceModuleIds: ['quorum_cli', 'autoresearch'],
  },
  tradeoff: {
    id: 'tradeoff',
    title: 'Tradeoff',
    turnStrategy: 'criteria_scoring',
    defaultRounds: 3,
    consensusPolicy: 'lead_final_judgment',
    requiredRoleSlots: [
      { id: 'option_a', description: 'Argues option A', stance: 'pro' },
      { id: 'option_b', description: 'Argues option B', stance: 'con' },
      { id: 'evaluator', description: 'Scores and adjudicates', stance: 'neutral' },
    ],
    outputSections: [
      'round_summaries',
      'final_judgment',
      'rationale',
      'minority_note',
      'followups',
    ],
    sourceModuleIds: ['quorum_cli', 'autoresearch'],
  },
};

const DEBATE_MODE_SPECS: Record<DebateModeId, DebateModeSpec> = {
  standard: {
    id: 'standard',
    title: 'Standard',
    description: 'Free round-robin discussion with practical convergence.',
    protocolId: 'standard',
    sourceModuleIds: ['quorum_cli'],
  },
  oxford: {
    id: 'oxford',
    title: 'Oxford',
    description: 'Formal pro/con framing with explicit opposition roles.',
    protocolId: 'oxford',
    sourceModuleIds: ['quorum_cli'],
  },
  advocate: {
    id: 'advocate',
    title: 'Advocate',
    description: 'One explicit challenger critiques the dominant direction.',
    protocolId: 'advocate',
    sourceModuleIds: ['quorum_cli'],
  },
  socratic: {
    id: 'socratic',
    title: 'Socratic',
    description: 'Question-led probing of assumptions before conclusion.',
    protocolId: 'socratic',
    sourceModuleIds: ['quorum_cli'],
  },
  delphi: {
    id: 'delphi',
    title: 'Delphi',
    description: 'Iterative estimate-and-revision convergence workflow.',
    protocolId: 'delphi',
    sourceModuleIds: ['quorum_cli'],
  },
  brainstorm: {
    id: 'brainstorm',
    title: 'Brainstorm',
    description: 'Diverge first, then converge into shortlisted options.',
    protocolId: 'brainstorm',
    sourceModuleIds: ['quorum_cli'],
  },
  tradeoff: {
    id: 'tradeoff',
    title: 'Tradeoff',
    description: 'Criteria-driven scoring and comparison.',
    protocolId: 'tradeoff',
    sourceModuleIds: ['quorum_cli'],
  },
};

const MODE_KEYWORDS: Array<{ mode: DebateModeId; pattern: RegExp }> = [
  { mode: 'oxford', pattern: /\boxford\b|옥스포드/iu },
  { mode: 'advocate', pattern: /\badvocate\b|반론|악마의 대변인/iu },
  { mode: 'socratic', pattern: /\bsocratic\b|소크라테스/iu },
  { mode: 'delphi', pattern: /\bdelphi\b|델파이/iu },
  { mode: 'brainstorm', pattern: /\bbrainstorm\b|브레인스토밍|아이디어/iu },
  { mode: 'tradeoff', pattern: /\btradeoff\b|트레이드오프|비교평가/iu },
  { mode: 'standard', pattern: /\bstandard\b|일반 토론|토론/iu },
];

const DEBATE_INTENT_PATTERN = /토론|debate|찬반|논쟁/iu;

function parseRoundsHint(text: string): number | null {
  const match = text.match(/(\d{1,2})\s*(?:라운드|round|회)/iu);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, 12);
}

function detectModeHint(text: string): DebateModeId | null {
  for (const candidate of MODE_KEYWORDS) {
    if (candidate.pattern.test(text)) return candidate.mode;
  }
  return null;
}

export function parseDebateIntent(text: string): DebateIntentSeed {
  const normalized = text.trim();
  const isDebateIntent = DEBATE_INTENT_PATTERN.test(normalized);
  if (!isDebateIntent) {
    return {
      isDebateIntent: false,
      modeHint: null,
      roundsHint: null,
      topic: null,
    };
  }

  return {
    isDebateIntent: true,
    modeHint: detectModeHint(normalized),
    roundsHint: parseRoundsHint(normalized),
    topic: normalized,
  };
}

export function listDebateModeSpecs(): DebateModeSpec[] {
  return Object.values(DEBATE_MODE_SPECS);
}

export function getDebateModeSpec(id: DebateModeId): DebateModeSpec | null {
  return DEBATE_MODE_SPECS[id] || null;
}

export function listDebateProtocolSpecs(): DebateProtocolSpec[] {
  return Object.values(DEBATE_PROTOCOL_SPECS);
}

export function getDebateProtocolSpec(
  id: DebateModeId,
): DebateProtocolSpec | null {
  return DEBATE_PROTOCOL_SPECS[id] || null;
}

export function resolveDebateContracts(modeId: DebateModeId): {
  input: DebateInputContract;
  output: DebateOutputContract;
} {
  const modeSpec = getDebateModeSpec(modeId);
  return {
    input: {
      topic: '',
      modeHint: modeSpec?.id || null,
      roundsHint: modeSpec
        ? (getDebateProtocolSpec(modeSpec.protocolId)?.defaultRounds ?? null)
        : null,
      participantsHint: null,
      backgroundKnowledgeRefs: [],
      evidencePacks: [],
    },
    output: {
      roundSummaries: [],
      finalJudgment: '',
      rationale: '',
      minorityNote: null,
      followups: [],
    },
  };
}

export function buildDebateServiceOverlay(
  participantIds: string[],
  roleAssignments: Record<string, string>,
  roundOverride: number | null,
  backgroundKnowledgeRefs: string[] = [],
): DebateServiceOverlayContract {
  return {
    participantIds,
    roleAssignments,
    roundOverride,
    backgroundKnowledgeRefs,
  };
}
