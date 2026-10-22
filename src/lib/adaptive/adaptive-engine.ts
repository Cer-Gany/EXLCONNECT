/**
 * Adaptive Engine — Core θ Estimation & Question Routing
 *
 * Implements competency-graph adaptive logic:
 * - θ (ability estimate) per competency, updated via EMA after each response
 * - Question selection: pick closest-difficulty question from the ideal target
 * - Mastery / floor detection to exit a competency early
 */

import type {
  AbilityEstimates,
  AdaptiveConfig,
  AdaptiveQuestion,
  DifficultyTier,
  LiveAdaptiveState,
} from "./types";
import { DEFAULT_ADAPTIVE_CONFIG, getDifficultyTier } from "./types";

// ── θ Update (EMA) ───────────────────────────────────────────────────

/**
 * Update the ability estimate for a competency using exponential moving average.
 *
 * θ_new = θ_old + learningRate × (responseScore − θ_old)
 *
 * The response score is mapped from [1, 10] into the same scale as θ to keep
 * the EMA mathematically consistent. Clamped to [0, 10].
 */
export function updateAbilityEstimate(
  currentTheta: number,
  responseScore: number,
  learningRate: number = DEFAULT_ADAPTIVE_CONFIG.learningRate,
): number {
  const updated = currentTheta + learningRate * (responseScore - currentTheta);
  return Math.max(0, Math.min(10, updated));
}

// ── Target Difficulty Calculation ─────────────────────────────────────

/**
 * Calculate the ideal next question difficulty based on current θ.
 *
 * We target slightly above θ (challenge zone) — not too hard to frustrate,
 * not too easy to be uninformative. If θ is high, push harder; if low, stay accessible.
 *
 * Formula: target = θ + (10 − θ) × 0.2 (always 20% above current estimate)
 * Clamped to [1, 10].
 */
export function getTargetDifficulty(theta: number): number {
  const target = theta + (10 - theta) * 0.2;
  return Math.max(1, Math.min(10, target));
}

// ── Question Selection ───────────────────────────────────────────────

/**
 * Select the best next question from the available pool.
 *
 * Priority:
 * 1. Match competency + closest difficulty to targetDifficulty
 * 2. Break ties by preferring questions not yet seen
 * 3. Returns null if no suitable question found for this competency
 */
export function selectQuestionForCompetency(
  competency: string,
  targetDifficulty: number,
  pool: AdaptiveQuestion[],
  usedIds: Set<string>,
): AdaptiveQuestion | null {
  const candidates = pool.filter(
    (q) => q.competencyGroup === competency && !usedIds.has(q.id),
  );

  if (candidates.length === 0) return null;

  // Sort by proximity to targetDifficulty (ascending distance), then by original order as tiebreak
  candidates.sort((a, b) => {
    const distA = Math.abs(a.difficultyLevel - targetDifficulty);
    const distB = Math.abs(b.difficultyLevel - targetDifficulty);
    if (Math.abs(distA - distB) < 0.5) return a.order - b.order;
    return distA - distB;
  });

  return candidates[0] ?? null;
}

/**
 * Determine which competency to assess next.
 *
 * Priority:
 * 1. Current competency (if within quota and not mastered/floored)
 * 2. Competency with lowest θ (most needs assessment) that still has questions
 * 3. Any competency with remaining questions
 */
export function selectNextCompetency(
  state: LiveAdaptiveState,
  pool: AdaptiveQuestion[],
  config: AdaptiveConfig,
): string | null {
  const usedIds = new Set(state.questionHistory.map((q) => q.questionId));

  // All distinct competencies in the pool
  const allCompetencies = [...new Set(pool.map((q) => q.competencyGroup))];

  // Build a set of competencies that still have available (unused) questions
  const availableCompetencies = allCompetencies.filter((comp) =>
    pool.some((q) => q.competencyGroup === comp && !usedIds.has(q.id)),
  );

  if (availableCompetencies.length === 0) return null;

  // Can we continue on the current competency?
  const cur = state.currentCompetency;
  if (cur && availableCompetencies.includes(cur)) {
    const served = state.questionsServedPerCompetency[cur] ?? 0;
    const mastered = state.masteredCompetencies.includes(cur);
    const floored = state.flooredCompetencies.includes(cur);
    const withinMax = served < config.maxQuestionsPerCompetency;

    if (!mastered && !floored && withinMax) {
      return cur;
    }
  }

  // Move to the next best competency
  // Filter out fully-served / mastered / floored ones
  const eligibleCompetencies = availableCompetencies.filter((comp) => {
    const served = state.questionsServedPerCompetency[comp] ?? 0;
    const mastered = state.masteredCompetencies.includes(comp);
    const floored = state.flooredCompetencies.includes(comp);
    return !mastered && !floored && served < config.maxQuestionsPerCompetency;
  });

  if (eligibleCompetencies.length === 0) {
    // All competencies are either done or have no questions — pick any with remaining questions
    return availableCompetencies[0] ?? null;
  }

  // Pick the competency with the lowest θ (most information to gain)
  eligibleCompetencies.sort((a, b) => {
    const thetaA = state.abilityEstimates[a] ?? config.startingDifficulty;
    const thetaB = state.abilityEstimates[b] ?? config.startingDifficulty;
    return thetaA - thetaB;
  });

  return eligibleCompetencies[0] ?? null;
}

// ── Mastery / Floor Detection ─────────────────────────────────────────

export function isCompetencyMastered(
  state: LiveAdaptiveState,
  competency: string,
  config: AdaptiveConfig,
): boolean {
  const theta = state.abilityEstimates[competency] ?? config.startingDifficulty;
  const served = state.questionsServedPerCompetency[competency] ?? 0;
  return (
    theta >= config.masteryThreshold &&
    served >= config.minQuestionsPerCompetency
  );
}

export function isCompetencyFloored(
  state: LiveAdaptiveState,
  competency: string,
  config: AdaptiveConfig,
): boolean {
  const theta = state.abilityEstimates[competency] ?? config.startingDifficulty;
  const served = state.questionsServedPerCompetency[competency] ?? 0;
  return (
    theta <= config.floorThreshold &&
    served >= config.minQuestionsPerCompetency
  );
}

// ── State Initialization ──────────────────────────────────────────────

export function initAdaptiveState(
  pool: AdaptiveQuestion[],
  config: AdaptiveConfig,
): LiveAdaptiveState {
  const competencies = [...new Set(pool.map((q) => q.competencyGroup))];
  const abilityEstimates: AbilityEstimates = {};
  const questionsServedPerCompetency: Record<string, number> = {};

  for (const comp of competencies) {
    abilityEstimates[comp] = config.startingDifficulty;
    questionsServedPerCompetency[comp] = 0;
  }

  return {
    abilityEstimates,
    questionHistory: [],
    currentCompetency: null,
    questionsServedPerCompetency,
    masteredCompetencies: [],
    flooredCompetencies: [],
    totalQuestionsServed: 0,
  };
}

// ── Main Routing Function ─────────────────────────────────────────────

export interface NextQuestionResult {
  /** The next question to serve, or null if the interview should end. */
  question: AdaptiveQuestion | null;
  /** The index of this question in the full sortedQuestions array. */
  sortedIndex: number | null;
  /** Whether the interview should end because all competencies are assessed. */
  shouldEnd: boolean;
  /** The competency being assessed with this question. */
  competency: string | null;
  /** Target difficulty used for selection. */
  targetDifficulty: number;
}

/**
 * Core adaptive routing: given current state, pick the next question.
 *
 * This is called AFTER scoring the previous answer and updating θ.
 * Returns the question to serve next, or signals the interview should end.
 */
export function selectNextAdaptiveQuestion(
  state: LiveAdaptiveState,
  pool: AdaptiveQuestion[],
  sortedQuestionsOrConfig: AdaptiveQuestion[] | AdaptiveConfig = pool,
  maybeConfig?: AdaptiveConfig,
): NextQuestionResult {
  const isSortedArray = Array.isArray(sortedQuestionsOrConfig);
  const sortedQuestions = isSortedArray ? sortedQuestionsOrConfig : pool;
  const config = (isSortedArray ? maybeConfig : (sortedQuestionsOrConfig as AdaptiveConfig)) ?? DEFAULT_ADAPTIVE_CONFIG;

  const usedIds = new Set(state.questionHistory.map((q) => q.questionId));

  const nextCompetency = selectNextCompetency(state, pool, config);

  if (!nextCompetency) {
    return {
      question: null,
      sortedIndex: null,
      shouldEnd: true,
      competency: null,
      targetDifficulty: 5,
    };
  }

  const theta = state.abilityEstimates[nextCompetency] ?? config.startingDifficulty;
  const targetDifficulty = getTargetDifficulty(theta);

  const question = selectQuestionForCompetency(
    nextCompetency,
    targetDifficulty,
    pool,
    usedIds,
  );

  if (!question) {
    return {
      question: null,
      sortedIndex: null,
      shouldEnd: true,
      competency: nextCompetency,
      targetDifficulty,
    };
  }

  // Find the index in the original sortedQuestions array (for relay compatibility)
  const sortedIndex = sortedQuestions.findIndex((q) => q.id === question.id);

  return {
    question,
    sortedIndex: sortedIndex >= 0 ? sortedIndex : null,
    shouldEnd: false,
    competency: nextCompetency,
    targetDifficulty,
  };
}

// ── State Update After Scoring ────────────────────────────────────────

/**
 * Apply a scored response to the adaptive state, updating θ and mastery flags.
 * Returns the updated state (immutably).
 */
export function applyResponseToState(
  state: LiveAdaptiveState,
  questionId: string,
  competency: string,
  score: number,
  config: AdaptiveConfig,
): LiveAdaptiveState {
  const prevTheta = state.abilityEstimates[competency] ?? config.startingDifficulty;
  const newTheta = updateAbilityEstimate(prevTheta, score, config.learningRate);

  const newEstimates = { ...state.abilityEstimates, [competency]: newTheta };
  const newServed = {
    ...state.questionsServedPerCompetency,
    [competency]: (state.questionsServedPerCompetency[competency] ?? 0) + 1,
  };

  // Update the questionHistory entry for this question with thetaAfter (or add if missing)
  const exists = state.questionHistory.some((h) => h.questionId === questionId);
  const updatedHistory = exists
    ? state.questionHistory.map((h) =>
        h.questionId === questionId
          ? { ...h, thetaAfter: newTheta, aiScore: score }
          : h,
      )
    : [
        ...state.questionHistory,
        {
          questionId,
          questionText: "",
          difficultyLevel: Math.round(prevTheta),
          skillTag: "",
          competencyGroup: competency,
          aiScore: score,
          scoreReasoning: null,
          thetaBefore: prevTheta,
          thetaAfter: newTheta,
          sortedIndex: state.totalQuestionsServed,
        },
      ];

  // Check mastery / floor
  const tempState: LiveAdaptiveState = {
    ...state,
    currentCompetency: competency,
    abilityEstimates: newEstimates,
    questionHistory: updatedHistory,
    questionsServedPerCompetency: newServed,
    totalQuestionsServed: state.totalQuestionsServed + 1,
  };

  const mastered = isCompetencyMastered(tempState, competency, config);
  const floored = isCompetencyFloored(tempState, competency, config);

  const masteredCompetencies = mastered && !state.masteredCompetencies.includes(competency)
    ? [...state.masteredCompetencies, competency]
    : state.masteredCompetencies;

  const flooredCompetencies = floored && !state.flooredCompetencies.includes(competency)
    ? [...state.flooredCompetencies, competency]
    : state.flooredCompetencies;

  return {
    ...tempState,
    masteredCompetencies,
    flooredCompetencies,
  };
}

// ── Completeness Check ────────────────────────────────────────────────

/**
 * Check if the adaptive interview should end.
 * True if: all competencies are mastered or floored, OR no questions remain.
 */
export function shouldEndAdaptiveInterview(
  state: LiveAdaptiveState,
  pool: AdaptiveQuestion[],
  config: AdaptiveConfig,
): boolean {
  const usedIds = new Set(state.questionHistory.map((q) => q.questionId));
  const remaining = pool.filter((q) => !usedIds.has(q.id));

  if (remaining.length === 0) return true;

  const allCompetencies = [...new Set(pool.map((q) => q.competencyGroup))];
  const allDone = allCompetencies.every(
    (comp) =>
      state.masteredCompetencies.includes(comp) ||
      state.flooredCompetencies.includes(comp) ||
      (state.questionsServedPerCompetency[comp] ?? 0) >= config.maxQuestionsPerCompetency,
  );

  return allDone;
}

// ── Difficulty Tier helpers ───────────────────────────────────────────

export { getDifficultyTier };
export type { DifficultyTier };
