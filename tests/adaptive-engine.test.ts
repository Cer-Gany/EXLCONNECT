import assert from "node:assert/strict";
import test from "node:test";

import {
  applyResponseToState,
  buildAdaptiveReport,
  getDifficultyTier,
  initAdaptiveState,
  isCompetencyFloored,
  isCompetencyMastered,
  selectNextAdaptiveQuestion,
  thetaToPercentile,
  updateAbilityEstimate,
} from "../src/lib/adaptive";
import { validateAdaptivePool } from "../src/lib/adaptive/pool-validation";
import type { AdaptiveConfig, AdaptiveQuestion, LiveAdaptiveState } from "../src/lib/adaptive/types";

const mockConfig: AdaptiveConfig = {
  startingDifficulty: 5,
  learningRate: 0.3,
  minQuestionsPerCompetency: 2,
  maxQuestionsPerCompetency: 4,
  masteryThreshold: 7.5,
  floorThreshold: 2.5,
};

const mockPool: AdaptiveQuestion[] = [
  // Technical competency
  { id: "tech-easy-1", text: "What is an array?", type: "OPEN_ENDED", difficultyLevel: 2, skillTag: "basics", competencyGroup: "technical", order: 0 },
  { id: "tech-med-1", text: "Explain binary search.", type: "OPEN_ENDED", difficultyLevel: 5, skillTag: "algorithms", competencyGroup: "technical", order: 1 },
  { id: "tech-hard-1", text: "Design a distributed key-value store.", type: "OPEN_ENDED", difficultyLevel: 9, skillTag: "systems", competencyGroup: "technical", order: 2 },
  { id: "tech-hard-2", text: "Optimize cache coherency protocol.", type: "OPEN_ENDED", difficultyLevel: 8, skillTag: "systems", competencyGroup: "technical", order: 3 },
  // Behavioral competency
  { id: "beh-easy-1", text: "Describe a project you worked on.", type: "OPEN_ENDED", difficultyLevel: 3, skillTag: "teamwork", competencyGroup: "behavioral", order: 4 },
  { id: "beh-med-1", text: "How do you handle conflict in a team?", type: "OPEN_ENDED", difficultyLevel: 6, skillTag: "conflict", competencyGroup: "behavioral", order: 5 },
  { id: "beh-hard-1", text: "Lead a high-stakes reorganization.", type: "OPEN_ENDED", difficultyLevel: 9, skillTag: "leadership", competencyGroup: "behavioral", order: 6 },
];

test("updateAbilityEstimate adjusts theta with EMA formula", () => {
  // Current θ: 5.0, Score: 8.0, lr: 0.3 -> 5.0 + 0.3 * (8.0 - 5.0) = 5.9
  const newThetaHigh = updateAbilityEstimate(5.0, 8.0, 0.3);
  assert.equal(Number(newThetaHigh.toFixed(2)), 5.9);

  // Current θ: 5.0, Score: 2.0, lr: 0.3 -> 5.0 + 0.3 * (2.0 - 5.0) = 4.1
  const newThetaLow = updateAbilityEstimate(5.0, 2.0, 0.3);
  assert.equal(Number(newThetaLow.toFixed(2)), 4.1);

  // Bounds checking: theta cannot exceed 10 or drop below 0
  assert.equal(updateAbilityEstimate(9.8, 10.0, 0.8), 9.96);
  assert.ok(updateAbilityEstimate(0.5, 0.0, 0.9) >= 0);
});

test("getDifficultyTier correctly partitions 1-10 levels", () => {
  assert.equal(getDifficultyTier(1), "EASY");
  assert.equal(getDifficultyTier(3), "EASY");
  assert.equal(getDifficultyTier(4), "MEDIUM");
  assert.equal(getDifficultyTier(7), "MEDIUM");
  assert.equal(getDifficultyTier(8), "HARD");
  assert.equal(getDifficultyTier(10), "HARD");
});


test("isCompetencyMastered requires minimum questions and high theta", () => {
  const state: LiveAdaptiveState = initAdaptiveState(mockPool, mockConfig);
  state.abilityEstimates["technical"] = 8.5;

  // Not mastered yet because 0 questions answered < minQuestionsPerCompetency (2)
  assert.equal(isCompetencyMastered(state, "technical", mockConfig), false);

  state.questionsServedPerCompetency["technical"] = 2;
  // Now mastered: theta 8.5 >= 7.5 and 2 questions served >= 2
  assert.equal(isCompetencyMastered(state, "technical", mockConfig), true);
});

test("isCompetencyFloored detects severe struggle after min questions", () => {
  const state: LiveAdaptiveState = initAdaptiveState(mockPool, mockConfig);
  state.abilityEstimates["technical"] = 2.0;
  state.questionsServedPerCompetency["technical"] = 1;

  // 1 question is not enough to declare a floor
  assert.equal(isCompetencyFloored(state, "technical", mockConfig), false);

  state.questionsServedPerCompetency["technical"] = 2;
  // Now floored: theta 2.0 <= 2.5 and 2 questions served >= 2
  assert.equal(isCompetencyFloored(state, "technical", mockConfig), true);
});

test("adaptive state progression and question selection routes logically", () => {
  let state = initAdaptiveState(mockPool, mockConfig);

  // 1. Initial selection: starts at startingDifficulty (5) in technical
  const res1 = selectNextAdaptiveQuestion(state, mockPool, mockConfig);
  assert.ok(res1.question);
  const q1 = res1.question!;
  assert.equal(q1.id, "tech-med-1"); // level 5 matches target 5

  // 2. Candidate nails q1 with score 10.0
  state = applyResponseToState(state, q1.id, q1.competencyGroup, 10.0, mockConfig);
  assert.ok(state.abilityEstimates["technical"] > 5.0);
  assert.equal(state.totalQuestionsServed, 1);

  // 3. Next selection: should seek harder question (level 8+)
  const res2 = selectNextAdaptiveQuestion(state, mockPool, mockConfig);
  assert.ok(res2.question);
  const q2 = res2.question!;
  assert.equal(q2.competencyGroup, "technical");
  assert.ok(q2.difficultyLevel >= 8); // Routed to hard question!

  // 4. Candidate scores 10.0 on q2 -> θ reaches 7.55 >= 7.5 -> mastery achieved!
  state = applyResponseToState(state, q2.id, q2.competencyGroup, 10.0, mockConfig);
  assert.ok(state.masteredCompetencies.includes("technical"));

  // 5. Next selection: should pivot to the next unmastered competency (behavioral)!
  const res3 = selectNextAdaptiveQuestion(state, mockPool, mockConfig);
  assert.ok(res3.question);
  const q3 = res3.question!;
  assert.equal(q3.competencyGroup, "behavioral");
});

test("thetaToPercentile translates ability estimate to realistic bell-curve benchmark", () => {
  assert.ok(thetaToPercentile(2.0) <= 25);
  assert.equal(thetaToPercentile(5.0), 50); // neutral benchmark at 50th percentile
  assert.ok(thetaToPercentile(7.5) >= 75);
  assert.ok(thetaToPercentile(9.0) >= 90);
});

test("buildAdaptiveReport creates complete audit trail and narrative", () => {
  let state = initAdaptiveState(mockPool, mockConfig);
  const res1 = selectNextAdaptiveQuestion(state, mockPool, mockConfig);
  const q1 = res1.question!;
  state = applyResponseToState(state, q1.id, q1.competencyGroup, 8.5, mockConfig);

  const report = buildAdaptiveReport(state, mockPool.length, mockConfig);

  assert.ok(report.overallTheta > 5.0);
  assert.ok(report.percentileEstimate > 50);
  assert.equal(report.questionsServed, 1);
  assert.equal(report.totalPoolSize, mockPool.length);
  assert.ok(report.competencyHeatmap.length > 0);
  assert.ok(report.adaptivePath.length === 1);
  assert.equal(report.adaptivePath[0].questionNumber, 1);
  assert.ok(report.pathNarrative.includes("adaptive interview served 1 question"));
});

test("validateAdaptivePool rejects pools without usable routing metadata", () => {
  const result = validateAdaptivePool([
    { difficultyLevel: 5, skillTag: "", competencyGroup: "" },
    { difficultyLevel: 5, skillTag: "", competencyGroup: "" },
  ]);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("competency groups")));
  assert.ok(result.missingMetadata > 0);
});

test("validateAdaptivePool accepts a multi-competency pool with tier coverage", () => {
  const result = validateAdaptivePool([
    { difficultyLevel: 2, skillTag: "syntax", competencyGroup: "technical" },
    { difficultyLevel: 5, skillTag: "algorithms", competencyGroup: "technical" },
    { difficultyLevel: 8, skillTag: "systems", competencyGroup: "technical" },
    { difficultyLevel: 2, skillTag: "teamwork", competencyGroup: "behavioral" },
    { difficultyLevel: 5, skillTag: "conflict", competencyGroup: "behavioral" },
    { difficultyLevel: 8, skillTag: "leadership", competencyGroup: "behavioral" },
  ]);

  assert.equal(result.valid, true);
  assert.deepEqual(result.competencies.sort(), ["behavioral", "technical"]);
  assert.equal(result.issues.length, 0);
});
