import { generateChatWithFallback } from "@/lib/ai/generator-run";
import { buildInterviewerPrompt } from "@/lib/ai/prompts/interviewer";
import { getProvider } from "@/lib/ai/registry";
import type { LLMMessage } from "@/lib/ai/types";
import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decideChatAdaptiveRoute } from "@/lib/adaptive/chat-routing";
import { NextResponse } from "next/server";

const log = createLogger("api/ai/chat");

const MOVE_ON_PATTERN =
  /\b(next\s*question|move\s*on|skip\s*(this|it)?|next\s*one|let'?s\s*(move|continue)\s*(on|forward)?)\b/i;

type ChatQuestion = {
  id: string;
  text: string;
  type?: string | null;
  difficultyLevel?: number | null;
  skillTag?: string | null;
  competencyGroup?: string | null;
};

export async function POST(req: Request) {
  const { sessionId, interviewId, messages, currentQuestionIndex, manualNavigation } =
    await req.json();

  try {
    const { data: interview } = await supabaseAdmin
      .from("interviews")
      .select("*, questions(*)")
      .eq("id", interviewId)
      .order("order", { referencedTable: "questions", ascending: true })
      .single();

    if (!interview) {
      return NextResponse.json(
        { error: "Interview not found" },
        { status: 404 },
      );
    }

    const provider = getProvider(interview.llmProvider);

    const conversationHistory: LLMMessage[] = (messages ?? [])
      .filter(
        (m: { role?: string; content?: string }) =>
          typeof m.content === "string" && m.content.trim().length > 0,
      )
      .map((m: { role: "user" | "assistant"; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content.trim(),
      }));

    const promptMessages = buildInterviewerPrompt({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interview: interview as any,
      conversationHistory,
      currentQuestionIndex: currentQuestionIndex ?? 0,
    });

    let response;
    try {
      response = await provider.generateResponse({
        messages: promptMessages,
        temperature: 0.7,
        maxTokens: 1024,
        model: interview.llmModel ?? undefined,
      });
    } catch (primaryErr) {
      log.warn("Primary chat provider failed, falling back to generator chain:", primaryErr);
      response = await generateChatWithFallback({
        messages: promptMessages,
        temperature: 0.7,
        maxTokens: 1024,
      });
    }

    let isComplete = response.content.includes("[INTERVIEW_COMPLETE]");
    let questionAdvanced = response.content.includes("[NEXT_QUESTION]");
    let nextQuestionIndex: number | null = null;
    let adaptiveShouldEnd = false;

    // Ignore [NEXT_QUESTION] in the greeting message — the AI sometimes
    // mistakenly includes it when first asking Q1 from the introduction.
    if (questionAdvanced && conversationHistory.length === 0) {
      questionAdvanced = false;
    }

    if (questionAdvanced && manualNavigation) {
      questionAdvanced = false;
    }

    let cleanContent = response.content
      .replace("[INTERVIEW_COMPLETE]", "")
      .replace("[NEXT_QUESTION]", "")
      .trim();

    // Fallback: detect when the AI moved to the next question without the marker.
    // This catches the common case where the user says "next question" and the AI
    // transitions verbally but forgets [NEXT_QUESTION].
    if (
      !manualNavigation &&
      !questionAdvanced &&
      !isComplete &&
      conversationHistory.length > 0
    ) {
      const lastUserMsg = [...conversationHistory]
        .reverse()
        .find((m) => m.role === "user");
      if (lastUserMsg) {
        const userText =
          typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : lastUserMsg.content.map((p) => ("text" in p ? p.text : "")).join(" ");
        const userAskedToMoveOn = MOVE_ON_PATTERN.test(userText);
        if (userAskedToMoveOn) {
          const questions = (interview.questions ?? []) as ChatQuestion[];
          const nextQ = questions[(currentQuestionIndex ?? 0) + 1];
          if (nextQ) {
            // Check if the AI's response references the next question's content
            const nextQWords = nextQ.text.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
            const responseLower = cleanContent.toLowerCase();
            const matchCount = nextQWords.filter((w) => responseLower.includes(w)).length;
            const matchRatio = nextQWords.length > 0 ? matchCount / nextQWords.length : 0;

            if (matchRatio >= 0.4) {
              questionAdvanced = true;
              log.info("Fallback: detected question advancement without marker", {
                sessionId,
                nextQuestionText: nextQ.text,
                matchRatio,
              });
            }
          }
        }
      }
    }

    if (questionAdvanced) {
      const questions = (interview.questions ?? []) as ChatQuestion[];
      const currentIndex = currentQuestionIndex ?? 0;
      const currentQuestion = questions[currentIndex];
      const nextIndex = currentIndex + 1;

      if (interview.adaptiveMode && !manualNavigation && currentQuestion) {
        const lastUserMessage = [...conversationHistory]
          .reverse()
          .find((message) => message.role === "user");

        if (lastUserMessage) {
          try {
            const scoreResponse = await fetch(
              new URL("/api/adaptive/score", req.url),
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  sessionId,
                  questionId: currentQuestion.id,
                  questionText: currentQuestion.text,
                  questionType: currentQuestion.type ?? "OPEN_ENDED",
                  difficultyLevel: currentQuestion.difficultyLevel ?? 5,
                  skillTag: currentQuestion.skillTag ?? "general",
                  competencyGroup: currentQuestion.competencyGroup ?? "general",
                  transcript: lastUserMessage.content,
                  llmProvider: interview.llmProvider,
                  llmModel: interview.llmModel,
                }),
              },
            );

            if (!scoreResponse.ok) {
              throw new Error(`adaptive score failed with ${scoreResponse.status}`);
            }

            const scoreData = await scoreResponse.json() as {
              scored?: { score?: number; depth?: string };
              updatedState?: { followUpsByQuestion?: Record<string, number> };
              nextSortedIndex?: number;
              shouldEnd?: boolean;
            };

            const score = scoreData.scored?.score ?? 5;
            const depth = scoreData.scored?.depth ?? "adequate";
            const followUpsUsed =
              scoreData.updatedState?.followUpsByQuestion?.[currentQuestion.id] ?? 0;
            const decision = decideChatAdaptiveRoute({
              score,
              depth: depth as "surface" | "adequate" | "deep",
              followUpsUsed,
              nextIndex,
              shouldEnd: scoreData.shouldEnd ?? false,
            });

            if (decision.kind === "follow_up") {
              const followUpResponse = await provider.generateResponse({
                messages: [
                  {
                    role: "user",
                    content: `You are conducting an interview. The candidate gave a weak or shallow answer.
Ask exactly one concise clarification question about the same competency.
Do not evaluate the answer, do not introduce a new topic, and do not mention scoring.
Question: "${currentQuestion.text}"
Candidate answer: "${lastUserMessage.content}"`,
                  },
                ],
                temperature: 0.5,
                maxTokens: 180,
                model: interview.llmModel ?? undefined,
              });
              cleanContent = followUpResponse.content
                .replace("[NEXT_QUESTION]", "")
                .replace("[INTERVIEW_COMPLETE]", "")
                .trim();
              const updatedState = scoreData.updatedState ?? {};
              const followUpsByQuestion = {
                ...(updatedState.followUpsByQuestion ?? {}),
                [currentQuestion.id]: followUpsUsed + 1,
              };
              await supabaseAdmin
                .from("sessions")
                .update({
                  adaptiveState: {
                    ...updatedState,
                    followUpsByQuestion,
                  },
                })
                .eq("id", sessionId);
              questionAdvanced = false;
              log.info("Adaptive chat requested bounded clarification follow-up", {
                sessionId,
                questionId: currentQuestion.id,
                score,
                depth,
              });
            } else if (decision.kind === "complete") {
              nextQuestionIndex = null;
              adaptiveShouldEnd = true;
              isComplete = true;
            } else if (
              typeof scoreData.nextSortedIndex === "number" &&
              scoreData.nextSortedIndex >= 0 &&
              scoreData.nextSortedIndex < questions.length
            ) {
              nextQuestionIndex = scoreData.nextSortedIndex;
              log.info("Adaptive chat routing selected next question", {
                sessionId,
                fromIndex: currentIndex,
                toIndex: nextQuestionIndex,
              });
            }
          } catch (error) {
            log.warn("Adaptive chat scoring failed; using sequential routing", {
              sessionId,
              error,
            });
          }
        }
      }

      const resolvedNextIndex = nextQuestionIndex ?? nextIndex;
      const nextQuestion = questions[resolvedNextIndex];
      if (nextQuestion && !adaptiveShouldEnd) {
        nextQuestionIndex = resolvedNextIndex;
        await supabaseAdmin
          .from("sessions")
          .update({ currentQuestionId: nextQuestion.id })
          .eq("id", sessionId);
      }
    }

    await supabaseAdmin.from("messages").insert({
      sessionId,
      role: "ASSISTANT" as const,
      content: cleanContent,
      wordCount: cleanContent.split(/\s+/).length,
    });

    return NextResponse.json({
      content: cleanContent,
      questionAdvanced,
      isComplete,
      nextQuestionIndex,
    });
  } catch (error) {
    log.error("Chat AI error:", error);
    return NextResponse.json(
      { error: "Failed to generate response" },
      { status: 500 },
    );
  }
}
