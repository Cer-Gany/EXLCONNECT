/**
 * POST /api/adaptive/score
 *
 * Called by the voice relay between questions (during the natural transition pause).
 * Scores the just-completed question, updates the adaptive state in the DB,
 * and returns the next question to serve along with the updated state.
 *
 * Body:
 *   sessionId      — Supabase session ID
 *   questionId     — ID of the question that was just answered
 *   questionText   — text of the question (for prompt context)
 *   questionType   — QuestionType enum value
 *   difficultyLevel— 1-10 difficulty of the served question
 *   skillTag       — fine-grained skill tag
 *   competencyGroup— broad competency group
 *   transcript     — candidate's answer transcript (user turns joined)
 *   thetaBefore    — θ before this question (for recording)
 *   llmProvider    — optional LLM provider override
 *   llmModel       — optional LLM model override
 *
 * Response:
 *   scored: ResponseScore
 *   updatedState: LiveAdaptiveState
 *   nextQuestion: AdaptiveQuestion | null
 *   nextSortedIndex: number | null
 *   shouldEnd: boolean
 */

import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import {
  applyResponseToState,
  buildAdaptiveReport,
  DEFAULT_ADAPTIVE_CONFIG,
  initAdaptiveState,
  selectNextAdaptiveQuestion,
  shouldEndAdaptiveInterview,
} from "@/lib/adaptive";
import { scoreResponse } from "@/lib/adaptive/response-scorer";
import type {
  AdaptiveConfig,
  AdaptiveQuestion,
  LiveAdaptiveState,
  ServedQuestion,
} from "@/lib/adaptive/types";

const log = createLogger("api/adaptive/score");

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const {
      sessionId,
      questionId,
      questionText,
      questionType,
      difficultyLevel,
      skillTag,
      competencyGroup,
      transcript,
      thetaBefore,
      llmProvider,
      llmModel,
    } = body as {
      sessionId?: string;
      questionId?: string;
      questionText?: string;
      questionType?: string;
      difficultyLevel?: number;
      skillTag?: string;
      competencyGroup?: string;
      transcript?: string;
      thetaBefore?: number;
      llmProvider?: string;
      llmModel?: string;
    };

    if (!sessionId || !questionId || !questionText || !competencyGroup) {
      return NextResponse.json(
        { error: "Missing required fields: sessionId, questionId, questionText, competencyGroup" },
        { status: 400 },
      );
    }

    // ── 1. Load session + interview + question pool ──────────────────
    const { data: session, error: sessionError } = await supabaseAdmin
      .from("sessions")
      .select("id, interviewId, adaptiveState")
      .eq("id", sessionId)
      .single();

    if (sessionError || !session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const { data: interview, error: interviewError } = await supabaseAdmin
      .from("interviews")
      .select("adaptiveConfig, llmProvider, llmModel")
      .eq("id", session.interviewId)
      .single();

    if (interviewError || !interview) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 });
    }

    // Load full question pool with adaptive metadata
    const { data: questionsRaw } = await supabaseAdmin
      .from("questions")
      .select(
        "id, text, type, description, options, order, timeLimitSeconds, difficultyLevel, skillTag, competencyGroup",
      )
      .eq("interviewId", session.interviewId)
      .order("order", { ascending: true });

    const pool: AdaptiveQuestion[] = (questionsRaw ?? []).map((q) => ({
      id: q.id as string,
      text: q.text as string,
      type: q.type as string,
      description: q.description as string | null,
      options: q.options as { options: string[]; allowMultiple?: boolean } | null,
      order: q.order as number,
      timeLimitSeconds: q.timeLimitSeconds as number | null,
      difficultyLevel: (q.difficultyLevel as number) ?? 5,
      skillTag: (q.skillTag as string) ?? "general",
      competencyGroup: (q.competencyGroup as string) ?? "general",
    }));

    // ── 2. Resolve config and state ─────────────────────────────────
    const config: AdaptiveConfig = {
      ...DEFAULT_ADAPTIVE_CONFIG,
      ...(typeof interview.adaptiveConfig === "object" && interview.adaptiveConfig !== null
        ? interview.adaptiveConfig
        : {}),
    };

    let adaptiveState: LiveAdaptiveState =
      (session.adaptiveState as LiveAdaptiveState | null) ??
      initAdaptiveState(pool, config);

    // ── 3. Score the response ────────────────────────────────────────
    const resolvedProvider = llmProvider ?? (interview.llmProvider as string | null) ?? undefined;
    const resolvedModel = llmModel ?? (interview.llmModel as string | null) ?? undefined;

    const scored = await scoreResponse(
      questionText,
      questionType ?? "OPEN_ENDED",
      difficultyLevel ?? 5,
      competencyGroup,
      transcript ?? "",
      resolvedProvider,
      resolvedModel,
    );

    log.info(
      `Scored Q[${questionId}] comp=${competencyGroup} diff=${difficultyLevel} → score=${scored.score} (${scored.depth}, conf=${scored.confidence})`,
    );

    // ── 4. Update the served question history entry ──────────────────
    // The relay calls this AFTER pushing the question to history with aiScore=null
    // We update the entry if it exists, or add it if not
    const existingIdx = adaptiveState.questionHistory.findIndex(
      (h) => h.questionId === questionId,
    );

    const resolvedThetaBefore =
      thetaBefore ??
      (adaptiveState.abilityEstimates[competencyGroup] ?? config.startingDifficulty);

    if (existingIdx >= 0) {
      adaptiveState = {
        ...adaptiveState,
        questionHistory: adaptiveState.questionHistory.map((h, i) =>
          i === existingIdx
            ? { ...h, aiScore: scored.score, scoreReasoning: scored.reasoning }
            : h,
        ),
      };
    } else {
      // Entry wasn't pre-added by the relay — add it now
      const newEntry: ServedQuestion = {
        questionId,
        questionText,
        difficultyLevel: difficultyLevel ?? 5,
        skillTag: skillTag ?? "general",
        competencyGroup,
        aiScore: scored.score,
        scoreReasoning: scored.reasoning,
        thetaBefore: resolvedThetaBefore,
        thetaAfter: null, // filled by applyResponseToState below
        sortedIndex: pool.findIndex((q) => q.id === questionId),
      };
      adaptiveState = {
        ...adaptiveState,
        questionHistory: [...adaptiveState.questionHistory, newEntry],
      };
    }

    // ── 5. Apply score to θ estimate ─────────────────────────────────
    adaptiveState = applyResponseToState(
      adaptiveState,
      questionId,
      competencyGroup,
      scored.score,
      config,
    );

    // Update currentCompetency
    adaptiveState = { ...adaptiveState, currentCompetency: competencyGroup };

    // ── 6. Select next question ──────────────────────────────────────
    const sortedPool = [...pool].sort((a, b) => a.order - b.order);
    const nextResult = selectNextAdaptiveQuestion(
      adaptiveState,
      pool,
      sortedPool,
      config,
    );

    const shouldEnd = nextResult.shouldEnd || shouldEndAdaptiveInterview(adaptiveState, pool, config);

    // ── 7. Persist adaptive response record ─────────────────────────
    const thetaAfter =
      adaptiveState.questionHistory.find((h) => h.questionId === questionId)?.thetaAfter ?? null;

    await supabaseAdmin.from("adaptive_question_responses").insert({
      sessionId,
      questionId,
      questionOrder: pool.findIndex((q) => q.id === questionId),
      difficultyServed: difficultyLevel ?? 5,
      aiScore: scored.score,
      scoreReasoning: scored.reasoning,
      thetaBefore: resolvedThetaBefore,
      thetaAfter,
      skillTag: skillTag ?? "general",
      competencyGroup,
    });

    // ── 8. Generate adaptive report if interview is ending ───────────
    let adaptiveReport = null;
    if (shouldEnd) {
      adaptiveReport = buildAdaptiveReport(adaptiveState, pool.length, config);
      log.info(
        `Adaptive interview ending — overall θ=${adaptiveReport.overallTheta}, p${adaptiveReport.percentileEstimate}`,
      );
    }

    // ── 9. Persist updated adaptive state to session ─────────────────
    await supabaseAdmin
      .from("sessions")
      .update({
        adaptiveState: adaptiveState as unknown as Record<string, unknown>,
        ...(adaptiveReport ? { adaptiveReport: adaptiveReport as unknown as Record<string, unknown> } : {}),
      })
      .eq("id", sessionId);

    return NextResponse.json({
      scored,
      updatedState: adaptiveState,
      nextQuestion: nextResult.question,
      nextSortedIndex: nextResult.sortedIndex,
      shouldEnd,
      adaptiveReport,
    });
  } catch (err) {
    log.error("Adaptive score endpoint error:", err);
    return NextResponse.json(
      { error: "Internal error during adaptive scoring" },
      { status: 500 },
    );
  }
}
