/**
 * Adaptive Report Generator
 *
 * Computes the post-session AdaptiveReport from the live adaptive state.
 * Called at interview completion — generates the competency heatmap,
 * path visualization data, percentile estimate, and recruiter narrative.
 */

import type {
  AdaptiveConfig,
  AdaptiveReport,
  CompetencyScore,
  LiveAdaptiveState,
  PathStep,
} from "./types";
import { getDifficultyTier } from "./types";

// ── Percentile Estimation ─────────────────────────────────────────────

/**
 * Maps a weighted average θ (0–10) to an estimated percentile (0–100).
 * Uses a sigmoid-like curve so that mid-range scores separate clearly.
 *
 * θ = 2   → ~10th percentile
 * θ = 5   → ~50th percentile
 * θ = 7.5 → ~80th percentile
 * θ = 9   → ~95th percentile
 */
export function thetaToPercentile(theta: number): number {
  // Logistic function centred at θ=5, steepness k=0.6
  const percentile = 100 / (1 + Math.exp(-0.6 * (theta - 5)));
  return Math.round(Math.max(1, Math.min(99, percentile)));
}

// ── Competency Status ─────────────────────────────────────────────────

function getCompetencyStatus(
  theta: number,
  mastered: boolean,
  floored: boolean,
): CompetencyScore["status"] {
  if (floored || theta < 3) return "floor";
  if (mastered || theta >= 8.5) return "expert";
  if (theta >= 6.5) return "proficient";
  return "developing";
}

// ── Path Narrative ────────────────────────────────────────────────────

function buildPathNarrative(
  state: LiveAdaptiveState,
  heatmap: CompetencyScore[],
): string {
  const total = state.totalQuestionsServed;
  const mastered = state.masteredCompetencies;
  const floored = state.flooredCompetencies;

  const highScorers = heatmap
    .filter((c) => c.status === "expert" || c.status === "proficient")
    .map((c) => c.competencyGroup);

  const lowScorers = heatmap
    .filter((c) => c.status === "floor" || c.status === "developing")
    .map((c) => c.competencyGroup);

  const parts: string[] = [];

  parts.push(
    `The adaptive interview served ${total} question${total !== 1 ? "s" : ""} across ${heatmap.length} competency area${heatmap.length !== 1 ? "s" : ""}.`,
  );

  if (mastered.length > 0) {
    parts.push(
      `The candidate demonstrated mastery in ${mastered.join(", ")}, triggering early advancement to the next competency.`,
    );
  }

  if (highScorers.length > 0) {
    parts.push(
      `Strong performance was observed in: ${highScorers.join(", ")}.`,
    );
  }

  if (lowScorers.length > 0) {
    parts.push(
      `Areas for development include: ${lowScorers.join(", ")}.`,
    );
  }

  if (floored.length > 0) {
    parts.push(
      `Assessment was shortened in ${floored.join(", ")} to avoid candidate frustration, as performance suggested foundational gaps.`,
    );
  }

  return parts.join(" ");
}

// ── Main Report Builder ───────────────────────────────────────────────

/**
 * Generate the full adaptive report from a completed session's adaptive state.
 */
export function buildAdaptiveReport(
  state: LiveAdaptiveState,
  poolSize: number,
  config: AdaptiveConfig,
): AdaptiveReport {
  // ── Competency Heatmap ────────────────────────────────────────────
  const allCompetencies = [
    ...new Set([
      ...Object.keys(state.abilityEstimates),
      ...state.questionHistory.map((q) => q.competencyGroup),
    ]),
  ];

  const competencyHeatmap: CompetencyScore[] = allCompetencies.map((comp) => {
    const theta = state.abilityEstimates[comp] ?? config.startingDifficulty;
    const mastered = state.masteredCompetencies.includes(comp);
    const floored = state.flooredCompetencies.includes(comp);
    const questionsAnswered = state.questionsServedPerCompetency[comp] ?? 0;

    // Average score for this competency
    const scoresForComp = state.questionHistory
      .filter((h) => h.competencyGroup === comp && h.aiScore !== null)
      .map((h) => h.aiScore as number);

    const averageScore =
      scoresForComp.length > 0
        ? scoresForComp.reduce((a, b) => a + b, 0) / scoresForComp.length
        : 0;

    return {
      competencyGroup: comp,
      finalTheta: Math.round(theta * 10) / 10,
      tier: getDifficultyTier(theta),
      status: getCompetencyStatus(theta, mastered, floored),
      questionsAnswered,
      averageScore: Math.round(averageScore * 10) / 10,
      mastered,
      floored,
    };
  });

  // ── Adaptive Path ─────────────────────────────────────────────────
  const adaptivePath: PathStep[] = state.questionHistory.map((h, idx) => ({
    questionNumber: idx + 1,
    questionText: h.questionText,
    competency: h.competencyGroup,
    difficultyLevel: h.difficultyLevel,
    tier: getDifficultyTier(h.difficultyLevel),
    aiScore: h.aiScore,
    thetaBefore: h.thetaBefore !== null ? Math.round(h.thetaBefore * 10) / 10 : null,
    thetaAfter: h.thetaAfter !== null ? Math.round(h.thetaAfter * 10) / 10 : null,
  }));

  // ── Overall θ (weighted average by questions served per competency) ─
  const totalWeightedTheta = allCompetencies.reduce((sum, comp) => {
    const theta = state.abilityEstimates[comp] ?? config.startingDifficulty;
    const weight = state.questionsServedPerCompetency[comp] ?? 1;
    return sum + theta * weight;
  }, 0);

  const totalWeight = allCompetencies.reduce((sum, comp) => {
    return sum + (state.questionsServedPerCompetency[comp] ?? 1);
  }, 0);

  const overallTheta =
    totalWeight > 0
      ? Math.round((totalWeightedTheta / totalWeight) * 10) / 10
      : config.startingDifficulty;

  // ── Difficulty Progression ────────────────────────────────────────
  const difficultyProgression = state.questionHistory.map((h) => h.difficultyLevel);

  // ── Early Completion ──────────────────────────────────────────────
  const earlyCompletionTriggered =
    state.masteredCompetencies.length > 0 ||
    state.totalQuestionsServed < poolSize;

  const pathNarrative = buildPathNarrative(state, competencyHeatmap);

  return {
    overallTheta,
    percentileEstimate: thetaToPercentile(overallTheta),
    competencyHeatmap,
    adaptivePath,
    questionsServed: state.totalQuestionsServed,
    totalPoolSize: poolSize,
    earlyCompletionTriggered,
    difficultyProgression,
    pathNarrative,
  };
}
