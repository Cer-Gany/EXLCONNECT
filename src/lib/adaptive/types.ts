/**
 * Adaptive Testing Engine — Type Definitions
 *
 * Implements a competency-graph adaptive model where each candidate's
 * ability (θ) per skill is estimated in real-time using an exponential
 * moving average, and questions are selected to maximize information gain.
 */

// ── Difficulty & Competency ──────────────────────────────────────────

/** Difficulty tier labels derived from difficultyLevel (1–10). */
export type DifficultyTier = "EASY" | "MEDIUM" | "HARD";

export function getDifficultyTier(level: number): DifficultyTier {
  if (level <= 3) return "EASY";
  if (level <= 7) return "MEDIUM";
  return "HARD";
}

// ── Question Pool ────────────────────────────────────────────────────

/** An adaptive-enabled question from the DB (questions table, extended). */
export interface AdaptiveQuestion {
  id: string;
  text: string;
  type: string;
  description?: string | null;
  options?: { options: string[]; allowMultiple?: boolean } | null;
  order: number;
  timeLimitSeconds?: number | null;
  /** 1–10 difficulty level assigned by the interview creator. */
  difficultyLevel: number;
  /** Fine-grained skill tag, e.g. "system_design", "communication". */
  skillTag: string;
  /** Broad competency group, e.g. "technical", "behavioral". */
  competencyGroup: string;
}

// ── θ (Theta) — Ability Estimates ────────────────────────────────────

/** Maps competency group → current θ estimate (0–10). */
export type AbilityEstimates = Record<string, number>;

// ── Served Question Record ────────────────────────────────────────────

export interface ServedQuestion {
  questionId: string;
  questionText: string;
  difficultyLevel: number;
  skillTag: string;
  competencyGroup: string;
  /** AI-evaluated score (1–10). Null if not yet scored (in-progress). */
  aiScore: number | null;
  /** Brief LLM justification for the score. */
  scoreReasoning: string | null;
  /** θ for this competency before the question was served. */
  thetaBefore: number;
  /** θ for this competency after scoring. Null if not yet scored. */
  thetaAfter: number | null;
  /** Index in sortedQuestions array (for relay compatibility). */
  sortedIndex: number;
}

// ── Live Session Adaptive State ───────────────────────────────────────

/**
 * Persisted to sessions.adaptiveState (jsonb).
 * Updated after every question transition.
 */
export interface LiveAdaptiveState {
  /** θ per competency group. */
  abilityEstimates: AbilityEstimates;
  /** Ordered history of questions served so far. */
  questionHistory: ServedQuestion[];
  /** The competency group currently being assessed. */
  currentCompetency: string | null;
  /** Number of questions served per competency group. */
  questionsServedPerCompetency: Record<string, number>;
  /** Competency groups where mastery has been confirmed. */
  masteredCompetencies: string[];
  /** Competency groups where the floor has been hit (θ ≤ floorThreshold). */
  flooredCompetencies: string[];
  /** Total questions served so far. */
  totalQuestionsServed: number;
  /** Bounded clarification follow-ups requested per question. */
  followUpsByQuestion?: Record<string, number>;
}

// ── Adaptive Configuration ────────────────────────────────────────────

/**
 * Persisted to interviews.adaptiveConfig (jsonb).
 * Creator-configured or defaults.
 */
export interface AdaptiveConfig {
  /** Starting θ for all competencies. Default: 5.0 */
  startingDifficulty: number;
  /** EMA learning rate for θ updates. Default: 0.3 */
  learningRate: number;
  /** Minimum questions per competency before moving on. Default: 2 */
  minQuestionsPerCompetency: number;
  /** Maximum questions per competency. Default: 6 */
  maxQuestionsPerCompetency: number;
  /**
   * θ threshold above which a competency is considered mastered
   * AND we've served at least minQuestionsPerCompetency. Default: 7.5
   */
  masteryThreshold: number;
  /**
   * θ threshold below which we stop probing the competency to avoid
   * candidate frustration. Default: 2.5
   */
  floorThreshold: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  startingDifficulty: 5,
  learningRate: 0.3,
  minQuestionsPerCompetency: 2,
  maxQuestionsPerCompetency: 6,
  masteryThreshold: 7.5,
  floorThreshold: 2.5,
};

// ── Response Scoring ──────────────────────────────────────────────────

export type ResponseDepth = "surface" | "adequate" | "deep";
export type ScoringConfidence = "low" | "medium" | "high";

export interface ResponseScore {
  /** 1–10 holistic quality score for the given question & difficulty. */
  score: number;
  /** 1–2 sentence justification from the LLM scorer. */
  reasoning: string;
  /** Depth of the candidate's answer. */
  depth: ResponseDepth;
  /** Scorer's confidence in its own evaluation. */
  confidence: ScoringConfidence;
}

// ── Post-Session Adaptive Report ──────────────────────────────────────

export interface CompetencyScore {
  competencyGroup: string;
  finalTheta: number;
  tier: DifficultyTier;
  /** Color-coded status. */
  status: "floor" | "developing" | "proficient" | "expert";
  questionsAnswered: number;
  averageScore: number;
  mastered: boolean;
  floored: boolean;
}

export interface PathStep {
  questionNumber: number;
  questionText: string;
  competency: string;
  difficultyLevel: number;
  tier: DifficultyTier;
  aiScore: number | null;
  thetaBefore: number | null;
  thetaAfter: number | null;
}

export interface AdaptiveReport {
  /** Weighted average θ across all competencies. */
  overallTheta: number;
  /** Estimated 0–100 percentile (derived from θ). */
  percentileEstimate: number;
  /** Per-competency breakdown. */
  competencyHeatmap: CompetencyScore[];
  /** Ordered path the interview took through the question pool. */
  adaptivePath: PathStep[];
  /** Total questions served (adaptive). */
  questionsServed: number;
  /** Total questions in the pool (for context). */
  totalPoolSize: number;
  /** True if the interview ended early due to mastery across all competencies. */
  earlyCompletionTriggered: boolean;
  /** Difficulty level of each served question, in order. */
  difficultyProgression: number[];
  /** Summary narrative of the adaptive path for the recruiter. */
  pathNarrative: string;
}
