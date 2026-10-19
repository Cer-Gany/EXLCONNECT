import type { AdaptiveQuestion } from "./types";

export interface AdaptivePoolValidation {
  valid: boolean;
  questionCount: number;
  competencies: string[];
  missingMetadata: number;
  issues: string[];
  warnings: string[];
}

const tiers = ["EASY", "MEDIUM", "HARD"] as const;

function tierForDifficulty(level: number): (typeof tiers)[number] {
  if (level <= 3) return "EASY";
  if (level <= 7) return "MEDIUM";
  return "HARD";
}

export function validateAdaptivePool(
  questions: Array<Pick<AdaptiveQuestion, "difficultyLevel" | "skillTag" | "competencyGroup">>,
): AdaptivePoolValidation {
  const competencies = [...new Set(
    questions
      .map((question) => question.competencyGroup.trim().toLowerCase())
      .filter(Boolean),
  )];
  const missingMetadata = questions.filter(
    (question) =>
      !question.competencyGroup.trim() ||
      !question.skillTag.trim() ||
      !Number.isFinite(question.difficultyLevel) ||
      question.difficultyLevel < 1 ||
      question.difficultyLevel > 10,
  ).length;

  const issues: string[] = [];
  const warnings: string[] = [];

  if (questions.length < 4) {
    issues.push("Add at least 4 questions before enabling adaptive mode.");
  }
  if (competencies.length < 2) {
    issues.push("Add at least 2 competency groups so the engine can route between areas.");
  }
  if (missingMetadata > 0) {
    issues.push(`${missingMetadata} question${missingMetadata === 1 ? "" : "s"} need a difficulty, skill tag, and competency group.`);
  }

  for (const competency of competencies) {
    const competencyQuestions = questions.filter(
      (question) => question.competencyGroup.trim().toLowerCase() === competency,
    );
    if (competencyQuestions.length < 3) {
      warnings.push(`${competency} has only ${competencyQuestions.length} question${competencyQuestions.length === 1 ? "" : "s"}; routing options may run out quickly.`);
    }

    const coveredTiers = new Set(
      competencyQuestions.map((question) => tierForDifficulty(question.difficultyLevel)),
    );
    const missingTiers = tiers.filter((tier) => !coveredTiers.has(tier));
    if (missingTiers.length > 0) {
      warnings.push(`${competency} has no ${missingTiers.join(" or ").toLowerCase()} question${missingTiers.length === 1 ? "" : "s"}.`);
    }
  }

  if (questions.every((question) => question.difficultyLevel === 5)) {
    warnings.push("Every question is difficulty 5, so the interview cannot meaningfully change difficulty.");
  }

  return {
    valid: issues.length === 0,
    questionCount: questions.length,
    competencies,
    missingMetadata,
    issues,
    warnings,
  };
}
