/**
 * Response Scorer — LLM-based real-time answer quality scoring.
 *
 * Evaluates a candidate's spoken/written response for a given question
 * on a 1–10 scale, calibrated to the question's difficulty level.
 *
 * Designed to be called during the transition pause between questions
 * (~2–4s natural gap) to determine the next adaptive question.
 */

import { getProvider, REPORT_MODEL } from "@/lib/ai/registry";
import { extractJson } from "@/lib/ai/extract-json";
import type { ResponseScore, ResponseDepth, ScoringConfidence } from "./types";

// ── Scoring Prompt ────────────────────────────────────────────────────

function buildScoringPrompt(
  questionText: string,
  questionType: string,
  difficultyLevel: number,
  competency: string,
  candidateAnswer: string,
): string {
  const difficultyLabel =
    difficultyLevel <= 3 ? "EASY" :
    difficultyLevel <= 7 ? "MEDIUM" : "HARD";

  const typeGuidance = (() => {
    switch (questionType) {
      case "CODING":
        return `
CODING QUESTION: Evaluate the candidate's description of their approach, algorithm choice,
time/space complexity awareness, and problem-solving clarity. A strong answer articulates
the approach clearly even if code isn't written, and shows understanding of edge cases.`;
      case "SINGLE_CHOICE":
      case "MULTIPLE_CHOICE":
        return `
CHOICE QUESTION: Evaluate whether the candidate selected a reasonable option AND provided
clear, well-reasoned justification. The choice itself matters less than the quality of reasoning.`;
      case "WHITEBOARD":
        return `
WHITEBOARD QUESTION: Evaluate the candidate's verbal explanation of their diagram or approach.
Look for structured thinking, clarity of communication, and awareness of trade-offs.`;
      case "RESEARCH":
        return `
RESEARCH QUESTION: Evaluate the breadth and specificity of information shared. Strong answers
include concrete examples, data points, timelines, and connections between sub-topics.`;
      default:
        return `
OPEN-ENDED QUESTION: Evaluate the quality, specificity, and depth of the candidate's answer.
Strong answers include concrete examples, clear structure, and genuine insight.`;
    }
  })();

  return `You are an expert interview evaluator assessing a candidate's response.

COMPETENCY BEING ASSESSED: ${competency}
QUESTION (difficulty ${difficultyLevel}/10 — ${difficultyLabel}): "${questionText}"
CANDIDATE'S ANSWER: "${candidateAnswer}"
${typeGuidance}

SCORING SCALE (1–10):
- 1–3: Incorrect, very vague, off-topic, or no substantive attempt
- 4–5: Partial understanding; touches the topic but lacks depth, specificity, or examples
- 6–7: Solid answer; addresses the question adequately with reasonable evidence or reasoning
- 8–9: Strong answer; well-structured, specific, shows genuine depth and experience
- 10: Exceptional; insightful, precise, goes meaningfully beyond what was asked

CALIBRATION: This is a ${difficultyLabel} (${difficultyLevel}/10) question.
Score relative to what a strong candidate should produce at this difficulty level.
For EASY questions: a score of 7+ requires a clear, confident, and reasonably complete answer.
For HARD questions: a score of 7+ requires showing real depth, nuance, or mastery.

IMPORTANT: Score ONLY based on the answer's quality for the specific question asked.
- SPEECH-TO-TEXT / ASR TOLERANCE: Candidate answers are transcribed from live spoken audio and may contain phonetic transcription artifacts, minor homophone mix-ups, or technical jargon misspellings (e.g., "sequel" for "SQL", "dockers" for "Docker", omitted punctuation). Do NOT penalize candidates for speech recognition imperfections. Focus strictly on their conceptual grasp, reasoning, and semantic intent.
- Do not penalize candidates for being concise if they covered the key points.
- Do not reward length alone — a 2-sentence perfect answer beats a 10-sentence vague one.

Respond ONLY with valid JSON (no markdown, no preamble):
{
  "score": <number 1-10>,
  "reasoning": "<1-2 sentence justification focusing on what was strong/missing>",
  "depth": "surface" | "adequate" | "deep",
  "confidence": "low" | "medium" | "high"
}`;
}

// ── Main Scorer Function ──────────────────────────────────────────────

/**
 * Score a candidate's response to a question using the configured LLM.
 *
 * @param questionText - The question that was asked
 * @param questionType - Type from QuestionType enum
 * @param difficultyLevel - 1–10 difficulty of the question
 * @param competency - The competency group being assessed
 * @param candidateAnswer - The candidate's answer (transcript or text)
 * @param llmProvider - Optional provider override (defaults to REPORT_MODEL provider)
 * @param model - Optional model override
 */
export async function scoreResponse(
  questionText: string,
  questionType: string,
  difficultyLevel: number,
  competency: string,
  candidateAnswer: string,
  llmProvider?: string | null,
  model?: string | null,
): Promise<ResponseScore> {
  // Fallback for empty or very short answers
  const trimmed = candidateAnswer.trim();
  if (!trimmed || trimmed.length < 5) {
    return {
      score: 1,
      reasoning: "No substantive answer was provided.",
      depth: "surface",
      confidence: "high",
    };
  }

  const prompt = buildScoringPrompt(
    questionText,
    questionType,
    difficultyLevel,
    competency,
    candidateAnswer,
  );

  const provider = getProvider(llmProvider ?? model ?? REPORT_MODEL);
  const resolvedModel = model ?? provider.defaultModel;

  try {
    const response = await provider.generateResponse({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1, // Low temperature for consistent scoring
      maxTokens: 256,
      model: resolvedModel,
    });

    const parsed = extractJson<{
      score?: unknown;
      reasoning?: unknown;
      depth?: unknown;
      confidence?: unknown;
    }>(response.content);

    const score = typeof parsed.score === "number"
      ? Math.max(1, Math.min(10, parsed.score))
      : 5;

    const reasoning = typeof parsed.reasoning === "string"
      ? parsed.reasoning
      : "Unable to generate reasoning.";

    const depth = (["surface", "adequate", "deep"] as ResponseDepth[]).includes(
      parsed.depth as ResponseDepth
    )
      ? (parsed.depth as ResponseDepth)
      : "adequate";

    const confidence = (["low", "medium", "high"] as ScoringConfidence[]).includes(
      parsed.confidence as ScoringConfidence
    )
      ? (parsed.confidence as ScoringConfidence)
      : "medium";

    return { score, reasoning, depth, confidence };
  } catch (err) {
    console.error("[adaptive/response-scorer] Scoring failed:", err);
    // Graceful fallback: return neutral score that won't dramatically shift θ
    return {
      score: 5,
      reasoning: "Scoring failed — neutral score applied.",
      depth: "adequate",
      confidence: "low",
    };
  }
}

// ── Transcript Extraction ─────────────────────────────────────────────

/**
 * Extract just the candidate (user) turns from a question transcript.
 * Used to get the answer text to score.
 */
export function extractCandidateAnswer(
  transcript: Array<{ role: "user" | "assistant"; text: string }>,
): string {
  return transcript
    .filter((t) => t.role === "user")
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join(" ");
}
