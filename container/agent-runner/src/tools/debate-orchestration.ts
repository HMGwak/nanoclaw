export const DEBATE_MODE_IDS = [
  'standard',
  'oxford',
  'advocate',
  'socratic',
  'delphi',
  'brainstorm',
  'tradeoff',
] as const;

export type DebateModeId = (typeof DEBATE_MODE_IDS)[number];

export type DebateEvidenceType =
  | 'web'
  | 'file'
  | 'memory'
  | 'karpathy_loop_brief';

export interface DebateEvidencePack {
  type: DebateEvidenceType;
  ref: string;
  title?: string;
  summary?: string;
}

export interface DebateRequest {
  topic: string;
  mode: DebateModeId;
  rounds: number;
  backgroundKnowledgeRefs: string[];
  evidencePacks: DebateEvidencePack[];
}

export interface DebateRoundSummary {
  round: number;
  workshopTeamlead: string;
  kimi: string;
  summary: string;
}

export interface DebateResult {
  ok: true;
  topic: string;
  mode: DebateModeId;
  rounds: number;
  output_style: 'summary_with_rounds';
  participant_roles: Record<string, string>;
  round_summaries: DebateRoundSummary[];
  synthesis: string;
}

export interface DebateAgentRunner {
  hasAgent(name: string): boolean;
  askAgent(
    name: string,
    prompt: string,
    systemPrompt?: string,
  ): Promise<string>;
}

type DebateProgressReporter = (message: string) => void;

interface DebateModeSpec {
  title: string;
  defaultRounds: number;
  participantRoles: {
    workshopTeamlead: string;
    kimi: string;
    judge: string;
  };
  framing: string;
}

const AGENT_NAMES = {
  workshopTeamlead: '작업실 팀장',
  kimi: '키미',
  judge: '기획실 판정관',
} as const;

const MODE_SPECS: Record<DebateModeId, DebateModeSpec> = {
  standard: {
    title: 'Standard',
    defaultRounds: 3,
    participantRoles: {
      workshopTeamlead: 'speaker_a',
      kimi: 'speaker_b',
      judge: 'final judge',
    },
    framing: 'practical back-and-forth toward a working conclusion',
  },
  oxford: {
    title: 'Oxford',
    defaultRounds: 3,
    participantRoles: {
      workshopTeamlead: 'proposer',
      kimi: 'opposer',
      judge: 'adjudicator',
    },
    framing: 'formal pro versus con framing with a neutral adjudicator',
  },
  advocate: {
    title: 'Advocate',
    defaultRounds: 3,
    participantRoles: {
      workshopTeamlead: 'defender',
      kimi: 'advocate',
      judge: 'final judge',
    },
    framing: 'one side defends the working path while the other attacks it',
  },
  socratic: {
    title: 'Socratic',
    defaultRounds: 4,
    participantRoles: {
      workshopTeamlead: 'respondent',
      kimi: 'questioner',
      judge: 'synthesizer',
    },
    framing: 'question-led probing of assumptions before a conclusion',
  },
  delphi: {
    title: 'Delphi',
    defaultRounds: 3,
    participantRoles: {
      workshopTeamlead: 'estimator_a',
      kimi: 'estimator_b',
      judge: 'synthesizer',
    },
    framing: 'iterative estimate-and-revision convergence',
  },
  brainstorm: {
    title: 'Brainstorm',
    defaultRounds: 3,
    participantRoles: {
      workshopTeamlead: 'ideator_a',
      kimi: 'ideator_b',
      judge: 'curator',
    },
    framing: 'diverge quickly, then converge into useful patterns',
  },
  tradeoff: {
    title: 'Tradeoff',
    defaultRounds: 3,
    participantRoles: {
      workshopTeamlead: 'option_a',
      kimi: 'option_b',
      judge: 'evaluator',
    },
    framing: 'criteria-based comparison of competing options',
  },
};

const INTERNAL_SKIP_RESPONSE = '<internal>skip</internal>';

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeEvidencePacks(
  value: unknown,
): { ok: true; packs: DebateEvidencePack[] } | { ok: false; error: string } {
  if (value === undefined) {
    return {
      ok: false,
      error:
        'evidence_packs is required; collect objective evidence first and pass it into run_debate',
    };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: 'evidence_packs must be an array when provided' };
  }
  if (value.length === 0) {
    return {
      ok: false,
      error:
        'evidence_packs must include at least one objective evidence item',
    };
  }

  const packs: DebateEvidencePack[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object') {
      return {
        ok: false,
        error: `evidence_packs[${index}] must be an object`,
      };
    }
    const pack = raw as Record<string, unknown>;
    const type = normalizeNonEmptyString(pack.type);
    if (
      type !== 'web' &&
      type !== 'file' &&
      type !== 'memory' &&
      type !== 'karpathy_loop_brief'
    ) {
      return {
        ok: false,
        error:
          'evidence_packs[].type must be one of: web, file, memory, karpathy_loop_brief',
      };
    }
    const ref = normalizeNonEmptyString(pack.ref);
    if (!ref) {
      return { ok: false, error: `evidence_packs[${index}].ref is required` };
    }
    packs.push({
      type,
      ref,
      title: normalizeNonEmptyString(pack.title),
      summary: normalizeNonEmptyString(pack.summary),
    });
  }

  return { ok: true, packs };
}

export function validateDebateRequest(
  input: unknown,
): { ok: true; request: DebateRequest } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Debate request must be an object' };
  }
  const raw = input as Record<string, unknown>;
  const topic = normalizeNonEmptyString(raw.topic);
  if (!topic) return { ok: false, error: 'topic is required' };

  const mode = normalizeNonEmptyString(raw.mode);
  if (!mode || !DEBATE_MODE_IDS.includes(mode as DebateModeId)) {
    return {
      ok: false,
      error: `mode must be one of: ${DEBATE_MODE_IDS.join(', ')}`,
    };
  }

  const rounds =
    typeof raw.rounds === 'number' && Number.isInteger(raw.rounds)
      ? raw.rounds
      : MODE_SPECS[mode as DebateModeId].defaultRounds;
  if (rounds <= 0 || rounds > 12) {
    return { ok: false, error: 'rounds must be an integer between 1 and 12' };
  }

  const evidence = normalizeEvidencePacks(raw.evidence_packs);
  if (!evidence.ok) return evidence;

  return {
    ok: true,
    request: {
      topic,
      mode: mode as DebateModeId,
      rounds,
      backgroundKnowledgeRefs: normalizeStringList(raw.background_knowledge_refs),
      evidencePacks: evidence.packs,
    },
  };
}

function renderBackground(request: DebateRequest): string {
  const lines: string[] = [];
  lines.push(
    'Use the provided evidence packs as the primary basis for this debate.',
  );
  lines.push(
    'Do not rely on model prior knowledge alone when making claims about facts, current events, risks, or tradeoffs.',
  );
  lines.push(
    'If the evidence is insufficient, stale, or contested, use your allowed tools to gather additional corroboration before answering.',
  );
  if (request.backgroundKnowledgeRefs.length > 0) {
    lines.push('Background references:');
    for (const ref of request.backgroundKnowledgeRefs) {
      lines.push(`- ${ref}`);
    }
  }

  if (request.evidencePacks.length > 0) {
    lines.push('Evidence packs:');
    for (const pack of request.evidencePacks) {
      const extra = [pack.title, pack.summary].filter(Boolean).join(' | ');
      lines.push(
        `- [${pack.type}] ${pack.ref}${extra ? ` — ${extra}` : ''}`,
      );
    }
  }

  return lines.join('\n');
}

function buildRoleDirective(args: {
  mode: DebateModeId;
  role: string;
  counterpartRole: string;
  hasCounterpartResponse: boolean;
}): string {
  const mustOppose = args.hasCounterpartResponse
    ? 'Your conclusion must materially differ from the counterpart. Do not endorse the same recommendation in this round.'
    : 'Open with one clear, defensible position instead of hedging between both sides.';

  switch (args.mode) {
    case 'standard':
      return args.role === 'speaker_a'
        ? 'Advance one clear thesis and defend it with evidence.'
        : [
            'Argue the strongest opposing thesis to speaker_a.',
            mustOppose,
          ].join(' ');
    case 'oxford':
      return args.role === 'proposer'
        ? 'Support the motion and make the affirmative case.'
        : 'Reject the motion and attack the proposer case directly with evidence.';
    case 'advocate':
      return args.role === 'defender'
        ? 'Defend the currently stronger or default path with evidence.'
        : [
            'Argue the strongest competing path and expose the defender’s weak assumptions.',
            mustOppose,
          ].join(' ');
    case 'socratic':
      return args.role === 'respondent'
        ? 'Commit to a provisional thesis and answer challenges directly.'
        : 'Probe assumptions, force clarifications, and do not settle into agreement early.';
    case 'delphi':
      return args.role === 'estimator_a'
        ? 'Provide an independent estimate with explicit assumptions.'
        : 'Provide an independently reasoned estimate using a materially different assumption set from estimator_a.';
    case 'brainstorm':
      return args.role === 'ideator_a'
        ? 'Generate the first concrete option set.'
        : 'Generate distinct alternatives that do not simply repeat ideator_a.';
    case 'tradeoff':
      return args.role === 'option_a'
        ? 'Choose and defend one concrete option or side using the evidence.'
        : [
            'Defend the strongest opposing option or side to option_a.',
            mustOppose,
          ].join(' ');
    default:
      return 'Take a clear position and support it with evidence.';
  }
}

function renderPriorRounds(rounds: DebateRoundSummary[]): string {
  if (rounds.length === 0) return 'No prior rounds.';
  return rounds
    .map((round) => `- Round ${round.round}: ${round.summary}`)
    .join('\n');
}

function renderRoundProgressUpdate(args: {
  request: DebateRequest;
  round: DebateRoundSummary;
  roles: DebateModeSpec['participantRoles'];
}): string {
  const summaryLines = args.round.summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);

  return [
    `토론 진행 상황: 라운드 ${args.round.round}/${args.request.rounds} 종료`,
    `- 역할 구도: 작업실 팀장(${args.roles.workshopTeamlead}) vs 키미(${args.roles.kimi})`,
    '- 이번 라운드의 세부 발언은 내부 토론으로 유지하고, 판정 요약만 공유합니다.',
    '- 판정 요약:',
    ...summaryLines.map((line) => (line.startsWith('-') ? line : `- ${line}`)),
    args.round.round < args.request.rounds
      ? '- 다음 라운드를 이어서 진행합니다.'
      : '- 최종 종합 결론을 정리 중입니다.',
  ].join('\n');
}

function buildParticipantPrompt(args: {
  request: DebateRequest;
  role: string;
  counterpartRole: string;
  round: number;
  priorRounds: DebateRoundSummary[];
  counterpartLatest?: string;
}): string {
  const background = renderBackground(args.request);
  const sections = [
    `Topic: ${args.request.topic}`,
    `Mode: ${MODE_SPECS[args.request.mode].title}`,
    `Mode framing: ${MODE_SPECS[args.request.mode].framing}`,
    `Your role: ${args.role}`,
    `Counterpart role: ${args.counterpartRole}`,
    `Round: ${args.round}/${args.request.rounds}`,
    'Prior round summaries:',
    renderPriorRounds(args.priorRounds),
  ];

  if (background) sections.push(background);
  if (args.counterpartLatest) {
    sections.push('Latest counterpart response:');
    sections.push(args.counterpartLatest);
  }

  sections.push(
    'Respond in Korean.',
    'Be concrete and concise.',
    'Because you were explicitly asked to participate in this debate round, do not answer with <internal>skip</internal> unless the request is malformed or unsafe.',
    buildRoleDirective({
      mode: args.request.mode,
      role: args.role,
      counterpartRole: args.counterpartRole,
      hasCounterpartResponse: Boolean(args.counterpartLatest),
    }),
    'Anchor your claims to the provided evidence packs when possible, and note clearly when you are making an inference.',
    'You may use your allowed tools to verify or deepen the evidence before answering if needed.',
    'Include: current position, strongest reason, direct response to the counterpart, and the next pressure point.',
  );
  return sections.join('\n\n');
}

function isSkippedDebateContribution(response: string): boolean {
  const normalized = response.trim().toLowerCase();
  return normalized.length === 0 || normalized === INTERNAL_SKIP_RESPONSE;
}

async function askParticipantWithRetry(args: {
  runner: DebateAgentRunner;
  name: string;
  prompt: string;
  systemPrompt: string;
}): Promise<string> {
  const initial = await args.runner.askAgent(
    args.name,
    args.prompt,
    [
      args.systemPrompt,
      'Provide a substantive debate contribution for this round.',
      'Do not return <internal>skip</internal> unless the request is malformed or unsafe.',
    ].join(' '),
  );
  if (!isSkippedDebateContribution(initial)) return initial;

  return args.runner.askAgent(
    args.name,
    [
      args.prompt,
      'You were explicitly asked to participate in this debate round.',
      'Return a concrete position, rebuttal, and next pressure point instead of <internal>skip</internal>.',
    ].join('\n\n'),
    [
      args.systemPrompt,
      'This retry exists because your previous response was empty or <internal>skip</internal>.',
      'You must provide a substantive debate contribution for this round.',
    ].join(' '),
  );
}

function buildJudgeRoundPrompt(args: {
  request: DebateRequest;
  round: number;
  workshopTeamlead: string;
  kimi: string;
  priorRounds: DebateRoundSummary[];
}): string {
  return [
    `Topic: ${args.request.topic}`,
    `Mode: ${MODE_SPECS[args.request.mode].title}`,
    `Round: ${args.round}/${args.request.rounds}`,
    'Prior round summaries:',
    renderPriorRounds(args.priorRounds),
    'Workshop teamlead response:',
    args.workshopTeamlead,
    'Kimi response:',
    args.kimi,
    'Respond in Korean with 3-5 bullets only.',
    'Judge the round based on evidence quality, role separation, and argumentative strength.',
    'Summarize the strongest evidence-backed claim, the strongest rebuttal, any unsupported or weakly supported assertion, and what should be tested next.',
  ].join('\n\n');
}

function buildJudgeSynthesisPrompt(args: {
  request: DebateRequest;
  rounds: DebateRoundSummary[];
}): string {
  const background = renderBackground(args.request);
  const sections = [
    `Topic: ${args.request.topic}`,
    `Mode: ${MODE_SPECS[args.request.mode].title}`,
    'Round summaries:',
    args.rounds
      .map((round) => `Round ${round.round}\n${round.summary}`)
      .join('\n\n'),
  ];

  if (background) sections.push(background);
  sections.push(
    'Respond in Korean using this exact section order:',
    '결론:',
    '근거:',
    '소수 의견:',
    '다음 확인 포인트:',
    'Base the conclusion on the provided evidence and round summaries, not on unstated prior knowledge.',
    'If the evidence base is insufficient or stale, say so explicitly in 근거 or 다음 확인 포인트.',
    'Keep each section concise and decision-oriented.',
  );
  return sections.join('\n\n');
}

export async function runDebateWithAgents(
  request: DebateRequest,
  runner: DebateAgentRunner,
  log: (message: string) => void,
  onProgress?: DebateProgressReporter,
): Promise<DebateResult | { ok: false; error: string }> {
  const requiredAgents = [
    AGENT_NAMES.workshopTeamlead,
    AGENT_NAMES.kimi,
    AGENT_NAMES.judge,
  ];
  const missing = requiredAgents.filter((name) => !runner.hasAgent(name));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `run_debate requires imported debate agents: ${missing.join(', ')}`,
    };
  }

  const modeSpec = MODE_SPECS[request.mode];
  const rounds: DebateRoundSummary[] = [];

  for (let round = 1; round <= request.rounds; round++) {
    log(`run_debate: round=${round}/${request.rounds} mode=${request.mode}`);

    const workshopTeamlead = await askParticipantWithRetry({
      runner,
      name: AGENT_NAMES.workshopTeamlead,
      prompt: buildParticipantPrompt({
        request,
        role: modeSpec.participantRoles.workshopTeamlead,
        counterpartRole: modeSpec.participantRoles.kimi,
        round,
        priorRounds: rounds,
      }),
      systemPrompt: `You are the ${modeSpec.participantRoles.workshopTeamlead} in this debate.`,
    });

    const kimi = await askParticipantWithRetry({
      runner,
      name: AGENT_NAMES.kimi,
      prompt: buildParticipantPrompt({
        request,
        role: modeSpec.participantRoles.kimi,
        counterpartRole: modeSpec.participantRoles.workshopTeamlead,
        round,
        priorRounds: rounds,
        counterpartLatest: workshopTeamlead,
      }),
      systemPrompt: `You are the ${modeSpec.participantRoles.kimi} in this debate.`,
    });

    const summary = await runner.askAgent(
      AGENT_NAMES.judge,
      buildJudgeRoundPrompt({
        request,
        round,
        workshopTeamlead,
        kimi,
        priorRounds: rounds,
      }),
      `You are the ${modeSpec.participantRoles.judge}. Do not join the debate as a participant; summarize and judge the round.`,
    );

    const roundSummary: DebateRoundSummary = {
      round,
      workshopTeamlead,
      kimi,
      summary,
    };
    rounds.push(roundSummary);
    onProgress?.(
      renderRoundProgressUpdate({
        request,
        round: roundSummary,
        roles: modeSpec.participantRoles,
      }),
    );
  }

  const synthesis = await runner.askAgent(
    AGENT_NAMES.judge,
    buildJudgeSynthesisPrompt({ request, rounds }),
    `You are the ${modeSpec.participantRoles.judge}. Deliver the final synthesis and decision-ready output.`,
  );

  return {
    ok: true,
    topic: request.topic,
    mode: request.mode,
    rounds: request.rounds,
    output_style: 'summary_with_rounds',
    participant_roles: {
      [AGENT_NAMES.workshopTeamlead]: modeSpec.participantRoles.workshopTeamlead,
      [AGENT_NAMES.kimi]: modeSpec.participantRoles.kimi,
      [AGENT_NAMES.judge]: modeSpec.participantRoles.judge,
    },
    round_summaries: rounds,
    synthesis,
  };
}
