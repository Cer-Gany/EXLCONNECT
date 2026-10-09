/**
 * Voice relay using the Google Gemini Live API (native audio).
 *
 * Browser ←→ this relay ←→ Gemini Live (via @google/genai)
 *
 * Primary relay: server/voice-relay.ts (Volcengine S2S).
 * Run this as an alternative.
 *
 * Required env:
 *   GEMINI_API_KEY
 * Optional env:
 *   GEMINI_LIVE_MODEL        (default: gemini-2.5-flash-native-audio-preview-09-2025)
 *   GEMINI_VOICE             (default: Aoede)
 *   GEMINI_VAD_SILENCE_MS    (default: 1200)  end-of-speech silence before Gemini answers
 *   GEMINI_VOICE_RELAY_PORT / VOICE_RELAY_PORT (default: 8768)
 *   VOICE_ASR_PRIMARY        ("gemini" | "volc")
 *   DOUBAO_APP_ID, DOUBAO_ACCESS_TOKEN  (optional Volcengine ASR)
 *
 * Audio formats: browser → relay is 16 kHz PCM16 (Gemini accepts this directly,
 * no resampling needed). Gemini → relay is 24 kHz PCM16, forwarded as-is.
 */

import { randomUUID } from "crypto";
import { config } from "dotenv";
import {
  EndSensitivity,
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
  StartSensitivity,
  Type,
} from "@google/genai";
import { WebSocket, WebSocketServer } from "ws";
import { maxFollowUpsForDepth } from "../src/lib/follow-up-depth";
import { createLogger } from "../src/lib/logger";
import {
  DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES,
  DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS,
  followUpDepthPromptCopy,
  followUpLimitNotice,
  followUpsSpentOnQuestion,
  shouldAllowTtsBargeIn,
  shouldSendFollowUpLimitNotice,
} from "./openai-voice-relay-helpers";
import {
  type BigModelAsrConfig,
  BIGMODEL_ASR_URL,
  buildBigModelAudioRequest,
  buildBigModelFullRequest,
  buildBigModelHeaders,
  parseAsrResponse,
} from "./volcengine-asr";

const log = createLogger("gemini-relay");

config({ path: ".env.local", override: true });
config({ path: ".env" });

// ── Configuration ───────────────────────────────────────────────────

const RELAY_PORT =
  Number(process.env.GEMINI_VOICE_RELAY_PORT || process.env.VOICE_RELAY_PORT) ||
  8768;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ||
  "gemini-2.5-flash-native-audio-preview-09-2025";
const GEMINI_VOICE = process.env.GEMINI_VOICE || "Aoede";
const GEMINI_VAD_SILENCE_MS =
  Number(process.env.GEMINI_VAD_SILENCE_MS) || 1200;

if (!GEMINI_API_KEY) {
  log.error("Missing GEMINI_API_KEY in .env.local");
  process.exit(1);
}

const gemini = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ── Volcengine Big-Model streaming ASR config (optional) ────────────
const VOLC_ASR_APPID = process.env.DOUBAO_APP_ID || "";
const VOLC_ASR_TOKEN = process.env.DOUBAO_ACCESS_TOKEN || "";
const VOLC_ASR_AVAILABLE = !!(VOLC_ASR_APPID && VOLC_ASR_TOKEN);
const ASR_PRIMARY = (process.env.VOICE_ASR_PRIMARY || "gemini").toLowerCase();
const USE_VOLC_ASR_PRIMARY = VOLC_ASR_AVAILABLE && ASR_PRIMARY === "volc";
const USE_VOLC_ASR_INTERIMS = VOLC_ASR_AVAILABLE;

// Minimum RMS energy for user audio to be forwarded. 16-bit PCM silence is 0;
// typical speech is 500-5000.
const MIN_AUDIO_RMS = 160;
const TTS_BARGE_IN_RMS = 2400;
const TTS_BARGE_IN_FRAME_COUNT = 3;
// After the last loud frame keep forwarding (silence included) for this long so
// Gemini's server-side VAD can see the end of speech.
const SPEECH_HANGOVER_MS = 2500;

const AUDIO_MIME_16K = "audio/pcm;rate=16000";

const WHISPER_HALLUCINATIONS = new Set([
  "thank you.", "thank you", "thanks.", "thanks",
  "thank you for watching.", "thanks for watching.",
  "bye.", "bye", "goodbye.", "goodbye",
  "you", "the end.", "subscribe.",
  ".", "..", "...", " ",
]);

function isAsrHallucination(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed.length === 0 || WHISPER_HALLUCINATIONS.has(trimmed);
}

function looksLikeFarewell(text: string, isZh: boolean): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/[?？]/.test(normalized)) return false;

  const zhPatterns = [
    /再见/,
    /保重/,
    /一路顺利/,
    /祝你(?:一切顺利|顺利|好运)/,
    /感谢你今天的参与/,
    /祝你未来(?:的)?面试顺利/,
  ];
  const enPatterns = [
    /\bgood\s*bye\b/,
    /\bgoodbye\b/,
    /\bbye for now\b/,
    /\bthat'?s all for now\b/,
    /\ball for now\b/,
    /\btake care\b/,
    /\bbest of luck\b/,
    /\bwish you (?:the )?best\b/,
    /\bthank you (?:so much )?for your time\b/,
    /\bfuture interviews\b/,
  ];

  const patterns = isZh ? [...zhPatterns, ...enPatterns] : [...enPatterns, ...zhPatterns];
  return patterns.some((pattern) => pattern.test(normalized));
}

function mergeAsrText(previous: string, incoming: string): string {
  const prev = previous.trim();
  const next = incoming.trim();
  if (!next) return prev;
  if (!prev) return next;

  const prevLower = prev.toLowerCase();
  const nextLower = next.toLowerCase();

  if (nextLower.includes(prevLower)) return next;
  if (prevLower.includes(nextLower)) return prev;
  if (next.length + 8 < prev.length) return prev;

  return `${prev} ${next}`.replace(/\s+/g, " ").trim();
}

const FAST_NEXT_PATTERNS = [
  /^(?:下一个问题|下一题|跳过|next\s*question|skip)\.?$/i,
];

const FAST_PREV_PATTERNS = [
  /^(?:上一个问题|上一题|previous\s*question)\.?$/i,
];

const USER_SKIP_PATTERNS = [
  /(?:let'?s|please|can\s+(?:we|you))\s+(?:move\s+on|skip|proceed|go\s+to\s+(?:the\s+)?next)/i,
  /move\s+on(?:\s+to)?/i,
  /continue\s+to\s+(?:the\s+)?next/i,
  /go\s+(?:on\s+)?to\s+(?:the\s+)?next/i,
  /skip\s+(?:this|the)\s+(?:question|one|problem)/i,
  /I\s+(?:give\s+up|want\s+to\s+skip|'?d\s+like\s+to\s+skip)/i,
  /next\s+question/i,
  /please\s+(?:move\s+on|skip)/i,
  /(?:跳过|下一(?:个问题|题)|不做了|放弃了?|结束吧|请继续(?:下一|到下))/,
  /(?:我不会|不想做了|不想答了|过吧|换下一)/,
];

const USER_PREV_PATTERNS = [
  /(?:go|move|get)\s+back\s+(?:to\s+)?(?:the\s+)?(?:previous|last|prior)/i,
  /(?:return|go)\s+to\s+(?:the\s+)?(?:previous|last|prior)\s+(?:question|one|problem)/i,
  /(?:can|could)\s+(?:we|you|i)\s+(?:go|move|get)\s+back/i,
  /(?:let'?s|please|i\s+(?:want|need)\s+to)\s+(?:go|move|get)\s+back/i,
  /(?:revisit|re-visit)\s+(?:the\s+)?(?:previous|last|prior)/i,
  /previous\s+question/i,
  /(?:回到|返回|回去)(?:上一(?:个问题|题)|之前(?:的问题|那题))/,
  /(?:我(?:想|要|需要)|请|可以)(?:回到|返回|回去)上一/,
];

function isFastNextRequest(text: string): boolean {
  return FAST_NEXT_PATTERNS.some((p) => p.test(text.trim()));
}
function isFastPrevRequest(text: string): boolean {
  return FAST_PREV_PATTERNS.some((p) => p.test(text.trim()));
}
function isUserSkipRequest(text: string): boolean {
  return USER_SKIP_PATTERNS.some((p) => p.test(text));
}
function isUserPrevRequest(text: string): boolean {
  return USER_PREV_PATTERNS.some((p) => p.test(text));
}

// ── Interview context type ───────────────────────────────────────────

interface InterviewContext {
  title: string;
  objective?: string | null;
  aiName: string;
  aiTone: string;
  language: string;
  followUpDepth: string;
  startQuestionIndex?: number;
  questions: Array<{
    text: string;
    type: string;
    description?: string | null;
    options?: { options: string[]; allowMultiple?: boolean } | null;
    starterCode?: { language: string; code: string } | null;
    order: number;
  }>;
}

// ── Helpers ──────────────────────────────────────────────────────────

function isChineseInterview(ctx: InterviewContext): boolean {
  return ctx.language === "zh" || ctx.language.toLowerCase().includes("chinese");
}

function pcmRms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sumSq = 0;
  // readInt16LE avoids Int16Array alignment errors on pooled Buffers.
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / n);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── System prompt builder ───────────────────────────────────────────

function formatQuestionForPrompt(q: InterviewContext["questions"][0], index: number, total: number): string {
  let entry = `Question ${index + 1} of ${total}: [${q.type}] ${q.text}`;
  if (q.description) entry += `\nContext: ${q.description}`;
  if (q.options?.options?.length) {
    const labels = q.options.options.map((o, j) => `${String.fromCharCode(65 + j)}) ${o}`).join(", ");
    const multi = q.options.allowMultiple ? " (multiple choice)" : " (single choice)";
    entry += `\nOptions${multi}: ${labels}`;
  }
  if (q.type === "CODING") entry += `\nNote: The participant has a code editor. You cannot see their code unless they describe it.`;
  if (q.type === "WHITEBOARD") entry += `\nNote: The participant has a whiteboard. You will receive image updates silently — do NOT speak when you receive them. Only describe what you see when the participant asks you to look at it.`;
  return entry;
}

function buildSystemPrompt(ctx: InterviewContext, startIdx: number): string {
  const isZh = isChineseInterview(ctx);
  const sorted = ctx.questions.sort((a, b) => a.order - b.order);

  const maxFollowUps = maxFollowUpsForDepth(ctx.followUpDepth);
  const { summary: depthSummary, rule: depthRule } = followUpDepthPromptCopy(
    maxFollowUps,
    isZh,
  );

  const currentQObj = sorted[startIdx];
  const currentQuestionText = currentQObj ? formatQuestionForPrompt(currentQObj, startIdx, sorted.length) : "";

  const currentQ = startIdx + 1;

  if (isZh) {
    return `你是"${ctx.aiName}"，一位${ctx.aiTone}的AI面试官。

## 面试信息
- 主题: "${ctx.title}"
${ctx.objective ? `- 目标: ${ctx.objective}` : ""}
- 问题总数: ${sorted.length}
- 当前题目: 第${currentQ}个
- 每题追问深度: ${depthSummary}

## 当前问题
${currentQuestionText}

## 你的行为准则
1. 从第${currentQ}个问题开始。先用温暖友好的方式自我介绍（提到你的名字、面试主题和问题数量）。然后说一句过渡语，比如"我们开始吧，这是第一个问题。"之后再提出问题。问候、过渡语和问题必须是三个独立的句子，不要合并。
2. ${depthRule}
3. 严格专注当前问题！在当前题目下，你所提出的所有疑问都必须是针对当前题目的追问或提示。绝对不要在受访者尚未切换题目时主动念出下一题的内容。
4. 当当前问题讨论充分后（受访者给出了详细解答或编程完成，或追问次数用完）：
   - 简短总结认可回答（例如："谢谢你的回答，这道题的讨论就到这里。"）。
   - 明确告知受访者："准备好后，请点击下方的'下一题'按钮（或说'下一题'）继续。"
   - 然后停止说话，等待受访者操作。绝对不要在这一轮发言中念出或剧透下一道题的内容！
5. 当受访者点击"下一题"或说出"下一题"后，系统会先在受访者屏幕上渲染新题及代码编辑器/白板，并向你发送 [SYSTEM] 提示。只有收到系统的切换提示后，你才开始介绍并朗读新问题。
6. 所有问题结束后，调用 signal_question_change 并设 questionIndex 为 ${sorted.length}（超出范围），然后做简短总结告别。
7. 保持对话自然流畅，回复简洁（1-3句话）。语速要平缓，略慢于日常对话，让受访者能轻松跟上。可以使用简短友好的衔接语，比如"谢谢你的分享"、"我明白了"、"这很有帮助"。
8. 如果受访者口头明确要求"跳过"或"下一题"，简短回应后立即调用 signal_question_change 并设 userRequested=true。
9. 如果受访者口头明确要求"上一题"，调用 signal_question_change 并设 questionIndex 为上一题的索引，设 userRequested=true。

## 系统消息
以 [SYSTEM] 开头的消息来自面试系统，而不是受访者。请按其指示行动，但绝不要把这些消息念出来。

## 选择题的特殊规则
当提问单选题或多选题时，你必须把所有选项（A、B、C等）逐一朗读出来作为问题的一部分。受访者只能听到你说话——如果你不说出选项，他们就无法知道有哪些选择。列出选项后，请受访者选择并解释理由。对于多选题，提醒他们可以选择多个选项。

## 编程题/白板题的特殊规则
当进入编程题或白板题时：
- 不要朗读完整的题目内容！题目详情已经显示在受访者的屏幕上。只需简短说明这是编程题/白板题，请他们查看屏幕上的题目并使用编辑器/白板。
- 回复要保持简短，让受访者专注于思考和编码/绘画。
- 受访者的发言分为以下几类，请对应回复：
  1. 向你提问或对话 → 正常回应
  2. 说"完成了"/"做好了" → 请他们简短解释思路、复杂度；讨论充分后，邀请他们点击"下一题"按钮继续
  3. 自言自语或思考中 → 只用非常简短的鼓励（如"好的，继续"）
  4. 明确要跳过/放弃 → 简短鼓励后调用 signal_question_change 并设 userRequested=true
  5. 讨论已自然结束 → 简短感谢，告知受访者点击"下一题"按钮进入下一道题

## 语言要求
- 你必须始终用中文进行面试。你必须用中文回答。不要使用其他语言。

## 代码和白板可见性
- 你可以看到受访者的代码和白板内容！系统会通过 [CODE_UPDATE] 和 [WHITEBOARD_UPDATE] 消息将受访者编辑器中的代码和白板图片实时发送给你。
- 当受访者问你"能看到我的代码吗"或"看一下我写的"时，回答"是"并参考你收到的最新代码/白板内容。
- 不要在收到更新时主动开口——只在受访者和你说话时才提及。

## 重要规则
- 绝对不要自动念出下一题！每道题讨论完毕后，引导受访者点击"下一题"按钮，等屏幕渲染新题后由系统通知你再介绍新题。
- 如果受访者只是简单打招呼、确认性问题或模糊回答（如"你好"、"能听到吗?"、"我遇到过很多挑战"），先友好回应，再继续当前问题；不要调用 signal_question_change。这些不是实质性回答。必须等受访者给出详细、具体的回答后再切换。如果回答太简短或模糊，应追问以获取更多信息。
- 始终关注当前问题，不要跳到其他话题。
- 对于选择题，确保受访者给出选择并解释理由。
- 当受访者让你看白板时，描述你看到的内容并给出反馈。不要在收到图片更新时自动开口说话。`;
  }

  return `You are "${ctx.aiName}", a ${ctx.aiTone} AI interviewer.

## Interview Details
- Topic: "${ctx.title}"
${ctx.objective ? `- Objective: ${ctx.objective}` : ""}
- Total questions: ${sorted.length}
- Starting at: Question ${currentQ}
- Follow-up depth: ${depthSummary}

## Current Question
${currentQuestionText}

## Your Behavior
1. Start at question ${currentQ}. First, give a warm greeting — introduce yourself by name, mention the topic "${ctx.title}" and that there are ${sorted.length} questions. Then say a transition phrase like "Let's get started. Here is the first question." ONLY AFTER that, ask the question. The greeting, the transition phrase, and the question MUST be three separate sentences — NEVER combine them into one.
2. ${depthRule}
3. Stay strictly focused on the CURRENT question! Any questions or probes you ask are follow-up questions or hints on the current problem. NEVER recite, ask, or preview the next question while the candidate is still on this question.
4. When the current question is sufficiently discussed (or the candidate finishes coding / answering, or follow-up limit is reached):
   - Give a brief, encouraging acknowledgement (e.g., "Thank you, that covers this question." or "Great job on this problem.").
   - Explicitly invite the candidate to proceed: "Whenever you're ready, please click 'Next Question' (or use the button below) to move to the next problem."
   - Then STOP speaking and wait for the candidate. Do NOT ask, preview, or recite the next question in that turn!
5. When the candidate clicks "Next Question" (or says "next question"), the UI will update FIRST to render the new problem, constraints, and code editor on their screen. The system will then send you a [SYSTEM] prompt telling you the new question is rendered. ONLY AFTER you receive that system prompt should you introduce the new question.
6. After all questions are done, call signal_question_change with questionIndex=${sorted.length} (out of bounds), then give a brief wrap-up and farewell.
7. Keep responses concise (1-3 sentences) and conversational. Speak at a calm, unhurried pace — slightly slower than normal conversation speed so the participant can follow easily. Use brief friendly bridges like "Thanks for sharing that", "I appreciate the context", or "That makes sense" when appropriate.
8. If the participant verbally asks to "skip" or "next question", briefly acknowledge and immediately call signal_question_change with userRequested=true.
9. If the participant verbally asks for "previous question", call signal_question_change with the previous question's index and userRequested=true.

## System Messages
Messages that start with [SYSTEM] come from the interview system, NOT from the participant. Follow their instructions, but never read them aloud.

## Special Rules for Choice Questions
When asking a SINGLE_CHOICE or MULTIPLE_CHOICE question, you MUST read out ALL the answer options (A, B, C, etc.) as part of asking the question. The participant can only hear you — they cannot see the options unless you say them. After listing the options, ask the participant to choose and explain their reasoning. For multiple-choice questions, remind them they can select more than one option.

## Special Rules for Coding / Whiteboard Questions
When transitioning to a CODING or WHITEBOARD question:
- Do NOT read out the full question text! The question details are already displayed on the participant's screen. Just briefly say it's a coding/whiteboard question and ask them to read the problem on their screen and use the code editor/whiteboard.
- Keep your responses short — let the participant focus on thinking and coding/drawing.
- Categorize the participant's speech and respond accordingly:
  1. Talking TO YOU (asking questions, discussing approach) → Respond naturally
  2. Saying they're DONE ("I'm done", "finished") → Ask about their approach, time/space complexity, and possible improvements. When discussion concludes, tell them: "Whenever you're ready, please click 'Next Question' to continue."
  3. Thinking ALOUD (self-talk, "hmm", reading code) → Brief encouragement only (e.g. "Take your time")
  4. Wanting to SKIP ("I can't do this", "skip", "next question") → Brief encouragement, then call signal_question_change with userRequested=true
  5. Discussion naturally CONCLUDED → Brief acknowledgement, then tell the candidate: "Whenever you're ready, please click 'Next Question' to proceed."

## Language Requirements
- YOU MUST ALWAYS RESPOND IN ENGLISH. You must conduct this interview entirely in English. Do not switch to any other language under any circumstance.

## Code and Whiteboard Visibility
- You CAN see the participant's code and whiteboard! The system sends you real-time updates via [CODE_UPDATE] and [WHITEBOARD_UPDATE] messages containing their editor code and whiteboard images.
- When the participant asks "can you see my code?" or "look at what I wrote", answer YES and reference the latest code/whiteboard content you received.
- Do NOT proactively speak when you receive an update — only reference the content when the participant addresses you.

## Important Rules
- NEVER recite the next question on your own while still on the current question! Always conclude the current question and invite the participant to click "Next Question".
- Do NOT call signal_question_change unless the participant explicitly requested it (userRequested=true) or all questions are finished.
- If the participant has only said a brief greeting, clarifying remark, or vague statement, first respond warmly and helpfully, then continue the current question. These are NOT substantive answers.
- Stay focused on the current question. Do not jump to unrelated topics.
- For choice questions, ensure the participant both selects an option AND explains their reasoning.
- When the participant asks you to look at the whiteboard, describe what you see and give feedback. Do NOT automatically start speaking when you receive a whiteboard image update — wait for the participant to address you.`;
}

// ── Gemini tool definitions ─────────────────────────────────────────

const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "signal_question_change",
        description:
          "Signal that the interview should move to a different question. Call this ONLY when the current question has been substantively discussed (the participant gave a real, detailed answer — NOT a vague statement like 'I had many challenges'), or when the participant explicitly asks to skip/go back. Do NOT call this after a brief greeting or clarification like 'can you hear me'. After calling, naturally introduce the next question in your spoken response.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            questionIndex: {
              type: Type.INTEGER,
              description:
                "Zero-based index of the question to move to. Use current+1 for next, current-1 for previous, or total_questions to signal interview end.",
            },
            userRequested: {
              type: Type.BOOLEAN,
              description:
                "Set to true ONLY if the participant explicitly asked to skip, go to next/previous question, or go back. Set to false (or omit) when you are transitioning because the discussion is complete.",
            },
          },
          required: ["questionIndex"],
        },
      },
    ],
  },
];

// ── Relay server ────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: RELAY_PORT });

log.info(`Gemini voice relay listening on ws://localhost:${RELAY_PORT}`);
log.info(`Gemini Live model: ${GEMINI_LIVE_MODEL} (voice=${GEMINI_VOICE})`);
log.info(`ASR: ${USE_VOLC_ASR_PRIMARY ? "Volcengine primary" : "Gemini Live transcription"}`);

wss.on("connection", (browserWs) => {
  log.info("Browser connected, waiting for init...");

  const timeout = setTimeout(() => {
    log.error("No init message received within 10s");
    browserWs.close();
  }, 10000);

  const handler = (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "mic_test") {
        clearTimeout(timeout);
        browserWs.removeListener("message", handler);
        handleMicTest(browserWs);
      } else if (msg.type === "init" && msg.context) {
        clearTimeout(timeout);
        browserWs.removeListener("message", handler);
        handleInterview(browserWs, msg.context as InterviewContext);
      }
    } catch { /* not JSON */ }
  };
  browserWs.on("message", handler);
});

// ── Mic test handler ────────────────────────────────────────────────

async function handleMicTest(browserWs: WebSocket) {
  log.info(`Mic test mode (${USE_VOLC_ASR_PRIMARY ? "Volcengine" : "Gemini"})`);

  let geminiMicSession: Session | null = null;
  let cleaningUp = false;
  let volcWs: WebSocket | null = null;
  let volcAlive = false;
  let volcAudioSeq = 1;
  let volcKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const autoTimeout = setTimeout(() => {
    log.info("Mic test auto-timeout");
    if (browserWs.readyState === WebSocket.OPEN)
      browserWs.send(JSON.stringify({ type: "timeout" }));
    cleanup();
  }, 10 * 60 * 1000);

  function cleanup() {
    cleaningUp = true;
    clearTimeout(autoTimeout);
    if (volcKeepAliveTimer) { clearInterval(volcKeepAliveTimer); volcKeepAliveTimer = null; }
    if (volcWs && volcWs.readyState === WebSocket.OPEN) {
      try {
        volcAudioSeq++;
        volcWs.send(buildBigModelAudioRequest(Buffer.alloc(0), volcAudioSeq, true));
      } catch { /* ignore */ }
    }
    volcWs?.close();
    volcWs = null;
    volcAlive = false;
    try { geminiMicSession?.close(); } catch { /* ignore */ }
    geminiMicSession = null;
  }

  async function connectMicTestVolcAsr() {
    const reqid = randomUUID().replace(/-/g, "");
    const asrConfig: BigModelAsrConfig = {
      format: "pcm", rate: 16000, bits: 16, channels: 1, codec: "raw",
      showUtterance: true, resultType: "full", enablePunc: true,
      endWindowSize: 800, forceToSpeechTime: 3000,
      enableNonstream: true, ssdVersion: "200",
    };

    const wsHeaders = buildBigModelHeaders(VOLC_ASR_APPID, VOLC_ASR_TOKEN, reqid);
    volcWs = new WebSocket(BIGMODEL_ASR_URL, { headers: wsHeaders });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Volcengine ASR connect timeout")), 10_000);
      volcWs!.on("open", () => { clearTimeout(t); resolve(); });
      volcWs!.on("error", (e) => { clearTimeout(t); reject(e); });
    });

    let micAsrAccum = "";
    volcWs.on("message", (data: Buffer) => {
      try {
        const resp = parseAsrResponse(Buffer.from(data));
        if (resp.messageType === 0x0b) {
          if (!volcAlive) { volcAlive = true; log.info("Mic test Volcengine ASR connected"); }
          return;
        }
        if (resp.errorCode || (resp.code && resp.code !== 1000)) {
          log.warn(`Mic test Volc ASR error: code=${resp.code || resp.errorCode}`);
          return;
        }
        if (!volcAlive) return;

        if (resp.utterances?.length) {
          const utt = resp.utterances[0];
          if (utt.text) {
            micAsrAccum = utt.text;
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "asr", data: { results: [{ text: micAsrAccum }] } }));
            }
          }
          if (utt.definite && micAsrAccum.trim()) {
            log.info(`Mic test ASR: ${JSON.stringify(micAsrAccum.trim())}`);
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "asr_ended" }));
            }
            micAsrAccum = "";
          }
        } else if (resp.text) {
          micAsrAccum = resp.text;
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: "asr", data: { results: [{ text: micAsrAccum }] } }));
          }
          if (resp.isLastPackage && micAsrAccum.trim()) {
            log.info(`Mic test ASR final: ${JSON.stringify(micAsrAccum.trim())}`);
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "asr_ended" }));
            }
            micAsrAccum = "";
          }
        }
      } catch (err) { log.error("Mic test Volc ASR parse error:", err); }
    });

    volcWs.send(buildBigModelFullRequest(asrConfig, reqid));
    volcAlive = true;

    volcWs.on("close", () => { volcAlive = false; });
    volcWs.on("error", (err: Error) => { log.error("Mic test Volc ASR error:", err.message); });

    volcKeepAliveTimer = setInterval(() => {
      if (!volcAlive || !volcWs || volcWs.readyState !== WebSocket.OPEN) return;
      volcAudioSeq++;
      volcWs.send(buildBigModelAudioRequest(Buffer.alloc(3200), volcAudioSeq));
    }, 5_000);
  }

  async function connectMicTestGemini() {
    log.info(`Connecting Gemini Live mic test using ${GEMINI_LIVE_MODEL}`);

    let micGeminiAccum = "";

    geminiMicSession = await gemini.live.connect({
      model: GEMINI_LIVE_MODEL,
      callbacks: {
        onopen: () => log.info("Gemini Live mic test connected"),
        onmessage: (message: LiveServerMessage) => {
          try {
            const sc = message.serverContent;
            if (!sc) return;

            // Input transcription arrives as incremental chunks.
            const chunk = sc.inputTranscription?.text;
            if (chunk) {
              micGeminiAccum += chunk;
              if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({
                  type: "asr",
                  data: { results: [{ text: micGeminiAccum.trim() }] },
                }));
              }
            }

            // The model starting to answer (or finishing) means the user's
            // utterance is over. The model's audio itself is discarded.
            if ((sc.modelTurn || sc.turnComplete) && micGeminiAccum.trim()) {
              log.info(`Mic test ASR: ${JSON.stringify(micGeminiAccum.trim())}`);
              if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ type: "asr_ended" }));
              }
              micGeminiAccum = "";
            }
          } catch (error) {
            log.error("Gemini mic test message error:", error);
          }
        },
        onerror: (error: ErrorEvent) => {
          log.error("Gemini Live mic test error:", error?.message ?? error);
        },
        onclose: (event: CloseEvent) => {
          log.info(`Gemini Live mic test closed: ${event?.reason || "connection closed"}`);
          if (!cleaningUp && browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: "disconnected" }));
          }
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction:
          "You are a microphone test. Never elaborate. After the user speaks, reply with the single word 'ok'.",
        inputAudioTranscription: {},
      },
    });

    log.info("Gemini Live mic test session created");
  }

  try {
    if (USE_VOLC_ASR_PRIMARY) {
      await connectMicTestVolcAsr();
    } else {
      await connectMicTestGemini();
    }

    browserWs.send(JSON.stringify({ type: "ready" }));

    browserWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "audio" || !msg.data) return;
        const pcm16k = Buffer.from(msg.data, "hex");

        if (volcAlive && volcWs && volcWs.readyState === WebSocket.OPEN) {
          volcAudioSeq++;
          volcWs.send(buildBigModelAudioRequest(pcm16k, volcAudioSeq));
        }

        if (geminiMicSession) {
          geminiMicSession.sendRealtimeInput({
            audio: { data: pcm16k.toString("base64"), mimeType: AUDIO_MIME_16K },
          });
        }
      } catch { /* ignore */ }
    });

    browserWs.on("close", () => {
      log.info("Mic test: browser disconnected");
      cleanup();
    });
  } catch (err) {
    log.error("Mic test failed:", err);
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({
        type: "error",
        message: `Mic test failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
    browserWs.close();
    cleanup();
  }
}

// ── Interview handler ───────────────────────────────────────────────

async function handleInterview(browserWs: WebSocket, ctx: InterviewContext) {
  const sortedQuestions = ctx.questions.sort((a, b) => a.order - b.order);
  const isZh = isChineseInterview(ctx);
  let currentQuestionIndex = ctx.startQuestionIndex ?? 0;
  let questionEnteredAt = Date.now();
  const MIN_QUESTION_DWELL_MS = 15_000;
  const MIN_WORDS_BEFORE_TRANSITION = 20;
  let userCommittedWordsThisQuestion = 0;
  const followUpBudget = maxFollowUpsForDepth(ctx.followUpDepth);
  /** Assistant turns the participant actually heard on the current question.
   *  The first one is the question itself, the rest are follow-ups. */
  let assistantTurnsThisQuestion = 0;
  let followUpLimitNoticeSent = false;
  let interviewDone = false;
  let browserClosed = false;

  // ── Gemini session state ──
  let geminiSession: Session | null = null;
  let geminiReady = false;
  let connId = 0;
  let resumeHandle: string | null = null;
  let reconnecting = false;
  let sessionStart = Date.now();
  let lastGeminiActivity = Date.now();

  // ── Turn / transcript state ──
  let inputTranscriptBuffer = "";
  let outputTranscriptBuffer = "";
  let modelIsSpeaking = false;
  /** True from the first model output of a turn until turnComplete/interrupted. */
  let responseActive = false;
  /** When set, model output is discarded until the current turn ends. Gemini
   *  has no response.cancel, so this is how we "cancel" a response locally. */
  let dropModelOutput = false;
  let dropResetTimer: ReturnType<typeof setTimeout> | null = null;
  let toolCallSinceLastTurn = false;
  let greetingRetries = 0;
  let initialGreetingText = "";

  let lastUserInput = 0;
  let lastLoudAt = 0;
  let lastTtsAudioTime = 0;
  const TTS_ECHO_COOLDOWN_MS = 1500;
  let isTransitioning = false;
  let pendingInterviewComplete = false;
  let interviewCompleteTimer: ReturnType<typeof setTimeout> | null = null;
  let responseTtsBytes = 0;
  let responseAudioStarted = false;
  let responseAudioStartedAt = 0;
  let pendingTtsText: string[] = [];
  let ttsBargeInFrames = 0;

  let geminiTranscriptionEnabled = true;
  let speechTranscriptCommitted = false;
  const STALE_ASR_GUARD_MS = 1500;
  let staleAsrGuardText = "";
  let staleAsrGuardUntil = 0;

  let latestCode = "";
  let latestCodeLanguage = "plaintext";
  void latestCode; void latestCodeLanguage;

  let pendingQuestionPrompt: string | null = null;
  let pendingPromptTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTransitionTimer: ReturnType<typeof setTimeout> | null = null;

  const conversationHistory: Array<{ role: "user" | "assistant"; text: string }> = [];
  const MAX_HISTORY_ENTRIES = 30;

  log.info(`Interview: "${ctx.title}" (${sortedQuestions.length} questions, lang=${ctx.language}, startQ=${currentQuestionIndex}, followUpDepth=${ctx.followUpDepth})`);

  // ── Small utilities ─────────────────────────────────────────────

  function send(msg: Record<string, unknown>) {
    if (browserWs.readyState === WebSocket.OPEN)
      browserWs.send(JSON.stringify(msg));
  }

  function sendBinary(buf: Buffer) {
    if (browserWs.readyState === WebSocket.OPEN)
      browserWs.send(buf, { binary: true });
  }

  function pushHistory(role: "user" | "assistant", text: string) {
    if (!text.trim()) return;
    if (role === "user" && !text.startsWith("[")) {
      userCommittedWordsThisQuestion += text.trim().split(/\s+/).length;
    }
    conversationHistory.push({ role, text: text.trim() });
    while (conversationHistory.length > MAX_HISTORY_ENTRIES) {
      conversationHistory.shift();
    }
  }

  function gemOk(): boolean {
    return !!geminiSession && geminiReady && !reconnecting;
  }

  /** Send realtime text. The model treats this as user input and RESPONDS. */
  function gSend(text: string): boolean {
    if (!gemOk()) return false;
    try {
      geminiSession!.sendRealtimeInput({ text });
      return true;
    } catch (err) {
      log.error("Gemini sendRealtimeInput(text) failed:", err);
      return false;
    }
  }

  /** Add context to the conversation WITHOUT triggering a response. */
  function gContext(parts: Array<Record<string, unknown>>): boolean {
    if (!gemOk()) return false;
    try {
      geminiSession!.sendClientContent({
        turns: [{ role: "user", parts: parts as never }],
        turnComplete: false,
      });
      return true;
    } catch (err) {
      log.warn("Gemini sendClientContent failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  function gAudio(pcm16k: Buffer) {
    if (!gemOk()) return;
    try {
      geminiSession!.sendRealtimeInput({
        audio: { data: pcm16k.toString("base64"), mimeType: AUDIO_MIME_16K },
      });
    } catch (err) {
      log.error("Gemini sendRealtimeInput(audio) failed:", err);
    }
  }

  function scheduleDropReset(ms = 800) {
    if (dropResetTimer) clearTimeout(dropResetTimer);
    if (!dropModelOutput) return;
    dropResetTimer = setTimeout(() => {
      dropResetTimer = null;
      dropModelOutput = false;
    }, ms);
  }

  function clearDropState() {
    dropModelOutput = false;
    if (dropResetTimer) { clearTimeout(dropResetTimer); dropResetTimer = null; }
  }

  function clearPendingTransition() {
    if (pendingTransitionTimer) {
      clearTimeout(pendingTransitionTimer);
      pendingTransitionTimer = null;
    }
  }

  function clearQuestionPrompt() {
    pendingQuestionPrompt = null;
    if (pendingPromptTimer) {
      clearTimeout(pendingPromptTimer);
      pendingPromptTimer = null;
    }
  }

  function sendQuestionPrompt(prompt: string, retriesLeft = 2) {
    pendingQuestionPrompt = prompt;
    if (pendingPromptTimer) clearTimeout(pendingPromptTimer);

    if (gemOk()) {
      scheduleDropReset();
      gSend(prompt);
    }

    pendingPromptTimer = setTimeout(() => {
      if (!pendingQuestionPrompt) return;
      if (retriesLeft > 0 && !browserClosed && !interviewDone) {
        log.warn(`No Gemini response to question prompt — retrying (${retriesLeft} left)`);
        sendQuestionPrompt(prompt, retriesLeft - 1);
      } else {
        log.warn("Gemini did not respond to question prompt after retries");
        pendingQuestionPrompt = null;
      }
    }, 6_000);
  }

  function resetResponseAudioState() {
    outputTranscriptBuffer = "";
    pendingTtsText = [];
    responseTtsBytes = 0;
    responseAudioStarted = false;
    responseAudioStartedAt = 0;
    modelIsSpeaking = false;
  }

  /** Locally cancel the in-progress model response (Gemini has no cancel event). */
  function cancelOngoingResponse() {
    if (responseActive || modelIsSpeaking || outputTranscriptBuffer) {
      dropModelOutput = true;
    }
    responseActive = false;
    resetResponseAudioState();
  }

  /**
   * Gemini has no "speech_stopped / create_response" control, so the model
   * answers on its own after server-side VAD. We use the first model output
   * as the signal that the user's turn is over and commit the transcript.
   */
  function beginModelResponse() {
    if (responseActive) return;
    responseActive = true;
    clearQuestionPrompt();
    flushPendingUserTurnBeforeAssistant();
  }

  // ── Follow-up budget ────────────────────────────────────────────

  function noteAssistantTurnAgainstFollowUpBudget() {
    assistantTurnsThisQuestion++;
    if (
      !shouldSendFollowUpLimitNotice({
        assistantTurnsThisQuestion,
        followUpBudget,
        noticeAlreadySent: followUpLimitNoticeSent,
        interviewDone,
      })
    ) {
      return;
    }

    followUpLimitNoticeSent = true;
    const qNum = currentQuestionIndex + 1;
    gContext([{ text: `[SYSTEM] ${followUpLimitNotice(qNum, followUpBudget, isZh)}` }]);
    const spent = followUpsSpentOnQuestion(assistantTurnsThisQuestion);
    log.info(`Follow-up budget spent on Q${qNum} (${spent}/${followUpBudget}) — instructed model to move on`);
  }

  // ── ASR handling ────────────────────────────────────────────────

  function normalizeAsrGuardText(text: string): string {
    return text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function shouldIgnoreStaleAsrText(text: string): boolean {
    if (!staleAsrGuardText || Date.now() > staleAsrGuardUntil) return false;
    const incoming = normalizeAsrGuardText(text);
    const previous = normalizeAsrGuardText(staleAsrGuardText);
    if (!incoming || !previous) return false;
    if (incoming === previous) return true;
    if (incoming.length >= 8 && previous.includes(incoming)) return true;
    if (previous.length >= 8 && incoming.includes(previous)) return true;
    return false;
  }

  function armStaleAsrGuard(text: string) {
    staleAsrGuardText = text;
    staleAsrGuardUntil = Date.now() + STALE_ASR_GUARD_MS;
  }

  function clearStaleAsrGuard() {
    staleAsrGuardText = "";
    staleAsrGuardUntil = 0;
  }

  function bestAvailableTranscript(): string {
    return mergeAsrText(inputTranscriptBuffer, volcAsrAccumulator).trim();
  }

  function commitUserTranscript(reason: string): string {
    if (speechTranscriptCommitted) return "";

    const committedText = bestAvailableTranscript();
    if (!committedText) return "";

    speechTranscriptCommitted = true;
    pushHistory("user", committedText);
    send({ type: "asr_ended", text: committedText });
    log.info(`Committed user transcript (${reason}): ${JSON.stringify(committedText)}`);
    inputTranscriptBuffer = "";
    volcAsrAccumulator = "";
    armStaleAsrGuard(committedText);
    return committedText;
  }

  function finalizeUserTurn(reason: string): string {
    const committed = commitUserTranscript(reason);
    if (committed) tryHandleExplicitUserNavigation(committed);
    return committed;
  }

  function tryAcceptFreshAsrText(text: string, label: string): boolean {
    if (!inputTranscriptBuffer && !volcAsrAccumulator && shouldIgnoreStaleAsrText(text)) {
      log.debug(`Ignored stale ${label}: ${JSON.stringify(text)}`);
      return false;
    }
    // New (non-stale) speech after a commit starts a fresh user turn.
    if (speechTranscriptCommitted) speechTranscriptCommitted = false;
    clearStaleAsrGuard();
    return true;
  }

  function emitInterimUserTranscript(text: string, allowWhenVolcSilent = false) {
    if (allowWhenVolcSilent && volcAsrAccumulator.trim()) return;
    send({ type: "asr", data: { results: [{ text }] } });
  }

  function handleVolcInterimText(text: string, label: string) {
    if (!tryAcceptFreshAsrText(text, label)) return;
    volcAsrAccumulator = mergeAsrText(volcAsrAccumulator, text);
    emitInterimUserTranscript(volcAsrAccumulator);
  }

  function handleVolcFinalText(reason: string, logLabel: string) {
    const userText = bestAvailableTranscript();
    if (userText && !volcAsrPreFlushed) {
      if (USE_VOLC_ASR_PRIMARY) {
        log.info(`${logLabel}: ${JSON.stringify(userText)}`);
        finalizeUserTurn(reason);
      } else {
        log.debug(`${logLabel} (interim-only): ${JSON.stringify(userText)}`);
        emitInterimUserTranscript(userText);
      }
    } else if (userText) {
      log.debug(`${logLabel} (skipped${volcAsrPreFlushed ? ", pre-flushed" : ""}): ${JSON.stringify(userText)}`);
    }
    volcAsrPreFlushed = false;
  }

  /** Gemini inputTranscription arrives as incremental chunks (not cumulative). */
  function handleGeminiInputTranscript(chunk: string) {
    if (!geminiTranscriptionEnabled || !chunk) return;
    // Late fragments of a turn the model is already answering are dropped.
    // A barge-in emits `interrupted`, which clears responseActive first.
    if (responseActive || dropModelOutput) return;
    if (!tryAcceptFreshAsrText(chunk, "Gemini transcript")) return;
    inputTranscriptBuffer += chunk;
    emitInterimUserTranscript(inputTranscriptBuffer.trim(), true);
  }

  function flushPendingUserTurnBeforeAssistant() {
    if (!speechTranscriptCommitted && bestAvailableTranscript()) {
      const pending = bestAvailableTranscript();
      if (isAsrHallucination(pending)) {
        log.debug(`ASR dropped (hallucination): ${JSON.stringify(pending)}`);
        inputTranscriptBuffer = "";
        volcAsrAccumulator = "";
        return;
      }
      volcAsrPreFlushed = true;
      log.info(`ASR pre-flush: ${JSON.stringify(pending)}`);
      finalizeUserTurn("response pre-flush");
      return;
    }

    if (volcAsrAccumulator.trim()) {
      log.debug(`Volc ASR pre-flush skipped (already committed): ${JSON.stringify(volcAsrAccumulator.trim())}`);
      volcAsrAccumulator = "";
      volcAsrPreFlushed = true;
    }
  }

  function setGeminiTranscriptionEnabled(enabled: boolean, reason: string) {
    // Gemini's input transcription cannot be toggled mid-session, so this only
    // controls whether we consume it. Disabled when Volcengine is primary+healthy.
    if (geminiTranscriptionEnabled === enabled) return;
    geminiTranscriptionEnabled = enabled;
    log.info(`Gemini transcription ${enabled ? "enabled" : "ignored"} (${reason})`);
  }

  function markInterviewComplete(reason: string) {
    if (!pendingInterviewComplete) return;
    pendingInterviewComplete = false;
    if (interviewCompleteTimer) {
      clearTimeout(interviewCompleteTimer);
      interviewCompleteTimer = null;
    }
    send({ type: "interview_complete" });
    log.info(`Interview complete (${reason})`);
  }

  function beginInterviewEnd(source: string) {
    if (interviewDone) return;
    interviewDone = true;
    pendingInterviewComplete = true;
    log.info(`Interview ending (${source}) — waiting for farewell TTS to finish`);
    interviewCompleteTimer = setTimeout(() => {
      if (pendingInterviewComplete) markInterviewComplete("timeout fallback");
    }, 15_000);
  }

  // ── ASR context for Volcengine deep reasoning ───────────────────

  function buildAsrContext(): Record<string, unknown> | undefined {
    const contextData: { text: string }[] = [];

    const currentQ = sortedQuestions[currentQuestionIndex];
    if (currentQ) {
      contextData.push({ text: `Interview topic: ${ctx.title}` });
      contextData.push({
        text: `Active question (${currentQuestionIndex + 1}/${sortedQuestions.length}): ${currentQ.text}`,
      });
    }

    const recentHistory = conversationHistory.slice(-12);
    for (const entry of recentHistory) {
      const who = entry.role === "user" ? "Participant" : "Interviewer";
      contextData.push({ text: `${who}: ${entry.text}` });
    }

    if (contextData.length === 0) return undefined;
    return {
      context: JSON.stringify({
        context_type: "dialog_ctx",
        context_data: contextData,
      }),
    };
  }

  // ── Volcengine Big-Model streaming ASR (optional) ───────────────
  let volcWs: WebSocket | null = null;
  let volcAlive = false;
  let volcAsrAccumulator = "";
  let volcAsrPreFlushed = false;
  let volcKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let volcSessionErrorLogged = false;
  let volcAudioSeq = 1;

  async function connectVolcAsr() {
    if (!USE_VOLC_ASR_INTERIMS) return;
    if (volcKeepAliveTimer) { clearInterval(volcKeepAliveTimer); volcKeepAliveTimer = null; }
    try {
      const reqid = randomUUID().replace(/-/g, "");
      volcAudioSeq = 1;

      const asrConfig: BigModelAsrConfig = {
        format: "pcm",
        rate: 16000,
        bits: 16,
        channels: 1,
        codec: "raw",
        showUtterance: true,
        resultType: "full",
        enablePunc: true,
        endWindowSize: 800,
        forceToSpeechTime: 3000,
        enableNonstream: true,
        ssdVersion: "200",
        corpus: buildAsrContext(),
      };

      const wsHeaders = buildBigModelHeaders(VOLC_ASR_APPID, VOLC_ASR_TOKEN, reqid);
      volcWs = new WebSocket(BIGMODEL_ASR_URL, { headers: wsHeaders });

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Volcengine ASR connect timeout")), 10_000);
        volcWs!.on("open", () => { clearTimeout(t); resolve(); });
        volcWs!.on("error", (e) => { clearTimeout(t); reject(e); });
      });

      volcWs.on("message", (data: Buffer) => {
        try {
          const resp = parseAsrResponse(Buffer.from(data));

          if (resp.messageType === 0x0b) {
            if (!volcAlive) {
              volcAlive = true;
              log.info("Volcengine Big-Model ASR connected (ACK received)");
              if (USE_VOLC_ASR_PRIMARY) {
                setGeminiTranscriptionEnabled(false, "Volcengine ASR connected");
              }
            }
            return;
          }

          if (resp.errorCode || (resp.code && resp.code !== 1000)) {
            const code = resp.code || resp.errorCode;
            const isSessionDead = code === 45000081 || code === 55000000;
            if (!isSessionDead || !volcSessionErrorLogged) {
              log.warn(`Volcengine ASR error: code=${code} ${resp.message || resp.errorMessage || ""}`);
              if (isSessionDead) volcSessionErrorLogged = true;
            }
            if (!volcAlive) {
              setGeminiTranscriptionEnabled(true, `Volcengine ASR error ${code}`);
              volcWs?.close();
            } else if (isSessionDead) {
              log.warn("Volcengine ASR session expired — reconnecting...");
              volcAlive = false;
              volcSessionErrorLogged = false;
              setGeminiTranscriptionEnabled(true, "Volcengine ASR session expired");
              volcWs?.close();
            }
            return;
          }

          if (!volcAlive) return;

          if (resp.utterances && resp.utterances.length > 0) {
            const utt = resp.utterances[0];
            if (utt.text && !volcAsrPreFlushed) {
              handleVolcInterimText(utt.text, "Volc ASR");
            }
            if (utt.definite) {
              handleVolcFinalText("volc definite", "Volc ASR");
            }
          } else if (resp.text && !volcAsrPreFlushed) {
            handleVolcInterimText(resp.text, "Volc ASR final");
            if (resp.isLastPackage) {
              handleVolcFinalText("volc final", "Volc ASR final");
            }
          }
        } catch (err) {
          log.error("Volcengine ASR parse error:", err);
        }
      });

      volcWs.send(buildBigModelFullRequest(asrConfig, reqid));
      volcAlive = true;

      volcWs.on("close", () => {
        volcAlive = false;
        setGeminiTranscriptionEnabled(true, "Volcengine ASR closed");
        if (!browserClosed && !interviewDone) reconnectVolcAsr();
      });

      volcWs.on("error", (err: Error) => {
        log.error("Volcengine ASR WS error:", err.message);
      });

      volcKeepAliveTimer = setInterval(() => {
        if (!volcAlive || !volcWs || volcWs.readyState !== WebSocket.OPEN) return;
        volcAudioSeq++;
        volcWs.send(buildBigModelAudioRequest(Buffer.alloc(3200), volcAudioSeq));
      }, 5_000);

      log.info("Volcengine Big-Model ASR WebSocket open, waiting for ACK...");
    } catch (err) {
      log.error("Volcengine ASR connection failed:", err instanceof Error ? err.message : err);
      volcAlive = false;
      setGeminiTranscriptionEnabled(true, "Volcengine ASR connection failed");
    }
  }

  function reconnectVolcAsr() {
    if (browserClosed || interviewDone) return;
    setTimeout(() => connectVolcAsr(), 2_000);
  }

  function cleanupVolcAsr() {
    volcAlive = false;
    if (volcKeepAliveTimer) { clearInterval(volcKeepAliveTimer); volcKeepAliveTimer = null; }
    if (volcWs && volcWs.readyState === WebSocket.OPEN) {
      try {
        volcAudioSeq++;
        volcWs.send(buildBigModelAudioRequest(Buffer.alloc(0), volcAudioSeq, true));
      } catch { /* ignore */ }
    }
    volcWs?.close();
    volcWs = null;
  }

  function sendAudioToVolc(pcm16kBuf: Buffer) {
    if (!volcAlive || !volcWs || volcWs.readyState !== WebSocket.OPEN) return;
    volcAudioSeq++;
    volcWs.send(buildBigModelAudioRequest(pcm16kBuf, volcAudioSeq));
  }

  connectVolcAsr();

  // ── Keepalive & liveness ────────────────────────────────────────

  // 100ms of 16 kHz silence = 16000 * 0.1 * 2 bytes = 3200 bytes
  let lastAudioSentToGemini = Date.now();
  const SILENCE_100MS_16K = Buffer.alloc(3200);
  const keepaliveTimer = setInterval(() => {
    if (!gemOk()) return;
    if (Date.now() - lastAudioSentToGemini > 4_000) {
      gAudio(SILENCE_100MS_16K);
      lastAudioSentToGemini = Date.now();
    }
  }, 5_000);

  const LIVENESS_TIMEOUT_MS = 120_000;
  const LIVENESS_INPUT_WINDOW_MS = 60_000;
  const livenessTimer = setInterval(() => {
    if (browserClosed || interviewDone || reconnecting) return;
    if (!geminiSession) return;
    const now = Date.now();
    const userRecentlyActive = now - lastUserInput < LIVENESS_INPUT_WINDOW_MS;
    const geminiSilent = now - lastGeminiActivity > LIVENESS_TIMEOUT_MS;
    if (userRecentlyActive && geminiSilent) {
      log.warn("User is active but Gemini silent for 2min — forcing reconnect");
      try { geminiSession.close(); } catch { /* ignore */ }
    }
  }, 15_000);

  // ── Question change tool logic ──────────────────────────────────

  function processQuestionChange(args: { questionIndex?: unknown; userRequested?: unknown }): string {
    const rawIdx = typeof args.questionIndex === "number" ? args.questionIndex : Number(args.questionIndex);
    const newIdx = Number.isFinite(rawIdx) ? Math.trunc(rawIdx) : currentQuestionIndex + 1;
    const userRequested = args.userRequested === true;
    log.info(`Gemini called signal_question_change → Q${newIdx + 1}${userRequested ? " (user requested)" : ""}`);

    if (isTransitioning) {
      return "A question transition is already in progress. Wait for the next system message before continuing.";
    }

    // Already on the requested question — no-op.
    if (newIdx >= 0 && newIdx < sortedQuestions.length && newIdx === currentQuestionIndex) {
      log.info(`Already on Q${newIdx + 1}, ignoring duplicate signal_question_change`);
      return `You are already on question ${newIdx + 1}. Continue the conversation naturally — do NOT call signal_question_change again unless the participant is ready for a different question.`;
    }

    // Reject autonomous forward transitions: candidate must click Next Question or ask to advance
    const isForward = newIdx > currentQuestionIndex && newIdx < sortedQuestions.length;
    if (isForward && !userRequested) {
      log.info(`Blocked autonomous forward transition: instructing AI to tell candidate to click Next Question`);
      return `Do not transition to the next question automatically. The candidate must click 'Next Question' (or say 'next question') so the new question and code editor can render on their screen first. Please conclude your comments on question ${currentQuestionIndex + 1} and invite the candidate: "Whenever you're ready, please click 'Next Question' to proceed." Do NOT recite the next question yourself.`;
    }

    // Reject premature transitions.
    const dwellMs = Date.now() - questionEnteredAt;
    const needsWordGuard = isForward && !userRequested;
    if (
      newIdx < sortedQuestions.length &&
      (lastUserInput === 0 ||
        dwellMs < MIN_QUESTION_DWELL_MS ||
        (needsWordGuard && userCommittedWordsThisQuestion < MIN_WORDS_BEFORE_TRANSITION))
    ) {
      const reason = lastUserInput === 0
        ? "the participant has not spoken yet"
        : (needsWordGuard && userCommittedWordsThisQuestion < MIN_WORDS_BEFORE_TRANSITION)
          ? `only ${userCommittedWordsThisQuestion} word(s) from participant (minimum ${MIN_WORDS_BEFORE_TRANSITION})`
          : `only ${Math.round(dwellMs / 1000)}s on this question (minimum ${MIN_QUESTION_DWELL_MS / 1000}s)`;
      log.warn(`Rejected premature question change: ${reason}`);
      return `Rejected: ${reason}. You MUST continue discussing question ${currentQuestionIndex + 1} and wait for a substantive response before calling signal_question_change. Do NOT verbally say you are moving to another question — the transition was blocked.`;
    }

    clearPendingTransition();

    if (newIdx >= sortedQuestions.length) {
      beginInterviewEnd("tool call");
      return "Interview is now complete. Please give a brief farewell.";
    }

    if (newIdx >= 0 && newIdx !== currentQuestionIndex) {
      const dir = newIdx > currentQuestionIndex ? "next" : "previous";
      const arrow = dir === "next" ? "→" : "←";
      send({ type: "transitioning", auto: true, direction: dir });
      currentQuestionIndex = newIdx;
      questionEnteredAt = Date.now();
      userCommittedWordsThisQuestion = 0;
      assistantTurnsThisQuestion = 0;
      followUpLimitNoticeSent = false;
      send({
        type: "question_change",
        questionIndex: currentQuestionIndex,
        totalQuestions: sortedQuestions.length,
        auto: true,
      });
      pushHistory("user", `[Moved to question ${currentQuestionIndex + 1}: "${sortedQuestions[currentQuestionIndex]?.text}"]`);
      log.info(`${arrow} Q${currentQuestionIndex + 1}/${sortedQuestions.length}`);
    }

    return `Moved to question ${newIdx + 1}: "${sortedQuestions[newIdx]?.text}". Please naturally transition and ask this question.`;
  }

  function handleToolCalls(calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>) {
    // Make sure the user's utterance is committed (word counts, history)
    // BEFORE the transition guards look at it.
    beginModelResponse();
    toolCallSinceLastTurn = true;

    const functionResponses = calls.map((fc) => {
      if (fc.name !== "signal_question_change") {
        return { id: fc.id, name: fc.name, response: { error: `Unknown function: ${fc.name}` } };
      }
      const output = processQuestionChange(fc.args ?? {});
      return { id: fc.id, name: fc.name, response: { output } };
    });

    try {
      geminiSession?.sendToolResponse({ functionResponses });
    } catch (err) {
      log.error("Gemini sendToolResponse failed:", err);
    }
  }

  // ── Gemini event handlers ───────────────────────────────────────

  function handleModelAudio(buf: Buffer) {
    if (dropModelOutput) return;
    beginModelResponse();
    modelIsSpeaking = true;
    if (isTransitioning) {
      log.warn("Audio suppressed: isTransitioning=true");
      return;
    }
    if (!responseAudioStarted) {
      responseAudioStarted = true;
      responseAudioStartedAt = Date.now();
      for (const t of pendingTtsText) send({ type: "tts_text", data: { text: t } });
      pendingTtsText = [];
    }
    lastTtsAudioTime = Date.now();
    responseTtsBytes += buf.length;
    sendBinary(buf);
  }

  function handleModelTranscriptDelta(text: string) {
    if (dropModelOutput || !text) return;
    beginModelResponse();
    outputTranscriptBuffer += text;
    if (responseAudioStarted) {
      send({ type: "tts_text", data: { text } });
    } else {
      pendingTtsText.push(text);
    }
  }

  function handleInterrupted() {
    log.debug("Gemini: model interrupted (user barge-in)");
    clearDropState();
    responseActive = false;
    resetResponseAudioState();
    speechTranscriptCommitted = false;
    volcAsrPreFlushed = false;
    send({ type: "interrupt" });
  }

  function handleTurnComplete() {
    const wasDropped = dropModelOutput;
    clearDropState();

    const hadTts = !!(outputTranscriptBuffer || modelIsSpeaking);
    const capturedModelText = outputTranscriptBuffer;
    const ttsBytes = responseTtsBytes;
    const hadToolCall = toolCallSinceLastTurn;
    toolCallSinceLastTurn = false;

    responseActive = false;
    resetResponseAudioState();
    speechTranscriptCommitted = false;
    volcAsrPreFlushed = false;

    if (wasDropped) {
      log.debug("Dropped (cancelled) model turn completed");
      return;
    }

    const inferredFarewell =
      !pendingInterviewComplete &&
      currentQuestionIndex >= sortedQuestions.length - 1 &&
      !!capturedModelText &&
      looksLikeFarewell(capturedModelText, isZh);

    if (inferredFarewell) {
      interviewDone = true;
      pendingInterviewComplete = true;
      log.warn("Inferred interview completion from farewell text on final question");
    }

    const completedFarewellTurn = pendingInterviewComplete && hadTts && ttsBytes > 0;

    if (hadTts && ttsBytes > 0) {
      if (capturedModelText) {
        log.info(`TTS done (${ttsBytes}B sent): ${JSON.stringify(capturedModelText)}`);
        pushHistory("assistant", capturedModelText);
        noteAssistantTurnAgainstFollowUpBudget();
      }
      send({ type: "tts_ended" });
    } else if (hadTts) {
      log.info(`TTS had no audio (0B): ${JSON.stringify(capturedModelText)}`);
    } else if (
      !hadToolCall &&
      lastUserInput === 0 &&
      !interviewDone &&
      !pendingQuestionPrompt &&
      !isTransitioning &&
      greetingRetries < 2 &&
      initialGreetingText
    ) {
      greetingRetries++;
      log.warn(`Greeting produced no output — retry ${greetingRetries}/2`);
      gSend(initialGreetingText);
    }

    if (completedFarewellTurn) {
      markInterviewComplete("after farewell");
    }
  }

  function handleGeminiMessage(msg: LiveServerMessage, myConn: number) {
    if (myConn !== connId) return;
    lastGeminiActivity = Date.now();

    if (msg.setupComplete) {
      geminiReady = true;
      log.info("Gemini Live setup complete");
    }

    const upd = msg.sessionResumptionUpdate;
    if (upd?.resumable && upd.newHandle) {
      resumeHandle = upd.newHandle;
    }

    if (msg.goAway) {
      log.warn(`Gemini goAway received (timeLeft=${msg.goAway.timeLeft ?? "unknown"}) — will resume on close`);
    }

    if (msg.toolCallCancellation?.ids?.length) {
      log.info(`Gemini cancelled tool calls: ${msg.toolCallCancellation.ids.join(",")}`);
    }

    const sc = msg.serverContent;
    if (sc?.interrupted) handleInterrupted();

    // Process user transcript before any model output so the pre-flush has it.
    const inChunk = sc?.inputTranscription?.text;
    if (inChunk) handleGeminiInputTranscript(inChunk);

    const outChunk = sc?.outputTranscription?.text;
    if (outChunk) handleModelTranscriptDelta(outChunk);

    for (const part of sc?.modelTurn?.parts ?? []) {
      const b64 = part.inlineData?.data;
      if (b64) handleModelAudio(Buffer.from(b64, "base64"));
    }

    if (msg.toolCall?.functionCalls?.length) {
      handleToolCalls(msg.toolCall.functionCalls);
    }

    if (sc?.turnComplete) handleTurnComplete();
  }

  // ── Gemini connection management ────────────────────────────────

  async function connectGemini(handle: string | null): Promise<Session> {
    const myConn = ++connId;
    geminiReady = false;
    log.info(`Connecting Gemini Live (${GEMINI_LIVE_MODEL})${handle ? " with resumption handle" : ""}`);

    const session = await gemini.live.connect({
      model: GEMINI_LIVE_MODEL,
      callbacks: {
        onopen: () => {
          if (myConn === connId) log.info("Gemini Live websocket open");
        },
        onmessage: (m: LiveServerMessage) => {
          try {
            handleGeminiMessage(m, myConn);
          } catch (err) {
            log.error("Error handling Gemini message:", err);
          }
        },
        onerror: (e: ErrorEvent) => {
          if (myConn === connId) log.error("Gemini Live error:", e?.message ?? e);
        },
        onclose: (e: CloseEvent) => {
          handleGeminiClose(myConn, e);
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildSystemPrompt(ctx, currentQuestionIndex),
        tools: GEMINI_TOOLS,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 150,
            silenceDurationMs: GEMINI_VAD_SILENCE_MS,
          },
        },
        // Lets sessions run past the default audio-length cap and survive reconnects.
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: handle ? { handle } : {},
      },
    });

    return session;
  }

  async function waitForGeminiReady(timeoutMs = 10_000) {
    const start = Date.now();
    while (!geminiReady) {
      if (Date.now() - start > timeoutMs) throw new Error("Gemini Live setup timeout");
      await sleep(50);
    }
  }

  function handleGeminiClose(myConn: number, e: CloseEvent) {
    if (myConn !== connId) return;
    const sessionDuration = ((Date.now() - sessionStart) / 1000).toFixed(1);
    log.info(`Gemini Live closed (session lasted ${sessionDuration}s): ${e?.reason || e?.code || "no reason"}`);
    geminiSession = null;
    geminiReady = false;

    if (browserClosed || interviewDone) return;

    if (inputTranscriptBuffer) pushHistory("user", inputTranscriptBuffer);
    if (outputTranscriptBuffer) pushHistory("assistant", outputTranscriptBuffer);
    inputTranscriptBuffer = "";
    responseActive = false;
    resetResponseAudioState();
    clearDropState();

    send({ type: "session_reconnecting" });
    log.info("Attempting auto-reconnect...");
    reconnectGemini().catch((err) => {
      log.error("Reconnect failed:", err);
      if (browserWs.readyState === WebSocket.OPEN) {
        send({ type: "disconnected" });
        browserWs.close();
      }
    });
  }

  async function reconnectGemini() {
    if (reconnecting) return;
    reconnecting = true;
    try {
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (browserClosed) return;
        try {
          const handle = resumeHandle;
          geminiSession = await connectGemini(handle);
          sessionStart = Date.now();
          await waitForGeminiReady();
          reconnecting = false;

          if (!handle) {
            // No server-side state to resume: replay recent history as context.
            const turns = conversationHistory.map((h) => ({
              role: h.role === "assistant" ? "model" : "user",
              parts: [{ text: h.text }],
            }));
            if (turns.length) {
              try {
                geminiSession.sendClientContent({ turns, turnComplete: false });
              } catch (err) {
                log.warn("History replay failed:", err instanceof Error ? err.message : err);
              }
            }
            gSend(
              `[SYSTEM] The connection was briefly interrupted and has been restored. Continue the interview from question ${currentQuestionIndex + 1} naturally with a very short apology, then continue.`,
            );
          }
          log.info("Gemini reconnected");
          send({ type: "session_resumed" });
          return;
        } catch (err) {
          lastErr = err;
          log.warn(`Reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
          await sleep(1000 * attempt);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("Gemini reconnect failed");
    } finally {
      reconnecting = false;
    }
  }

  // ── Initial connection ──────────────────────────────────────────

  try {
    geminiSession = await connectGemini(null);
    sessionStart = Date.now();
    await waitForGeminiReady();
    log.info("Gemini Live session established");

    send({ type: "ready", sessionId: "gemini-session" });
    send({
      type: "question_change",
      questionIndex: currentQuestionIndex,
      totalQuestions: sortedQuestions.length,
    });

    // Give the browser time to set up its AudioContext before streaming audio
    await sleep(1_500);

    const greeting = currentQuestionIndex > 0
      ? `The participant is returning to the interview. Continue from question ${currentQuestionIndex + 1}.`
      : "The participant has just joined. Please greet them and begin with question 1.";
    initialGreetingText = `[SYSTEM] ${greeting}`;
    gSend(initialGreetingText);
  } catch (err) {
    log.error("Failed to connect to Gemini:", err);
    send({
      type: "error",
      message: `Gemini connection failed: ${err instanceof Error ? err.message : err}`,
    });
    browserWs.close();
    return;
  }

  // ── Browser → Gemini ────────────────────────────────────────────

  function requestTransition(
    targetIdx: number,
    directionLabel: string,
    reason: "button" | "user_request" = "button",
  ) {
    clearPendingTransition();
    clearQuestionPrompt();
    cancelOngoingResponse();

    isTransitioning = true;
    const direction = targetIdx > currentQuestionIndex ? "next" : "previous";
    send({ type: "transitioning", direction });

    setTimeout(() => {
      if (targetIdx === currentQuestionIndex) {
        isTransitioning = false;
        return;
      }
      if (targetIdx >= sortedQuestions.length) {
        isTransitioning = false;
        beginInterviewEnd("button");
        scheduleDropReset();
        gSend("[SYSTEM] The participant chose to end the interview. Give a brief wrap-up and farewell now.");
        return;
      }
      const dir = targetIdx > currentQuestionIndex ? "→" : "←";
      currentQuestionIndex = targetIdx;
      questionEnteredAt = Date.now();
      userCommittedWordsThisQuestion = 0;
      assistantTurnsThisQuestion = 0;
      followUpLimitNoticeSent = false;
      pushHistory("user", `[Moved to question ${currentQuestionIndex + 1}: "${sortedQuestions[currentQuestionIndex]?.text}"]`);
      send({
        type: "question_change",
        questionIndex: currentQuestionIndex,
        totalQuestions: sortedQuestions.length,
      });
      isTransitioning = false;
      log.info(`${dir} Q${currentQuestionIndex + 1}/${sortedQuestions.length}`);

      const nextQ = sortedQuestions[currentQuestionIndex];
      const nextQDetails = nextQ ? formatQuestionForPrompt(nextQ, currentQuestionIndex, sortedQuestions.length) : "";
      const prompt = reason === "user_request"
        ? `[SYSTEM] The participant explicitly navigated to ${directionLabel.toLowerCase()}. The new question is now rendered on their screen:\n${nextQDetails}\nBriefly introduce and ask this question now.`
        : `[SYSTEM] The participant clicked "${directionLabel}". The new question is now rendered on their screen:\n${nextQDetails}\nBriefly introduce and ask this question now.`;
      sendQuestionPrompt(prompt);
    }, 500);
  }

  function tryHandleExplicitUserNavigation(text: string): boolean {
    const userText = text.trim();
    if (!userText || isTransitioning || interviewDone) return false;

    if (isFastPrevRequest(userText) || isUserPrevRequest(userText)) {
      if (currentQuestionIndex <= 0) return false;
      log.info(`Fast-path PREV transition from user: "${userText}"`);
      requestTransition(currentQuestionIndex - 1, "Previous Question", "user_request");
      return true;
    }

    if (isFastNextRequest(userText) || isUserSkipRequest(userText)) {
      const nextIdx = Math.min(currentQuestionIndex + 1, sortedQuestions.length);
      if (nextIdx === currentQuestionIndex) return false;
      log.info(`Fast-path NEXT transition from user: "${userText}"`);
      requestTransition(nextIdx, "Next Question", "user_request");
      return true;
    }

    return false;
  }

  browserWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "next_question") {
        log.info("Browser requested next question");
        const nextIdx = Math.min(currentQuestionIndex + 1, sortedQuestions.length);
        if (nextIdx !== currentQuestionIndex) requestTransition(nextIdx, "Next Question");
        return;
      }
      if (msg.type === "prev_question") {
        log.info("Browser requested previous question");
        const prevIdx = Math.max(currentQuestionIndex - 1, 0);
        if (prevIdx !== currentQuestionIndex) requestTransition(prevIdx, "Previous Question");
        return;
      }
      if (msg.type === "ping") {
        send({ type: "pong" });
        return;
      }

      if (reconnecting || !geminiSession || !geminiReady) return;

      if (msg.type === "audio" && msg.data) {
        if (isTransitioning) return;
        const pcm16k = Buffer.from(msg.data, "hex");
        const nowMs = Date.now();

        const rms = pcmRms(pcm16k);
        const aboveNoiseFloor = rms >= MIN_AUDIO_RMS;
        if (aboveNoiseFloor) lastLoudAt = nowMs;
        const inHangover = nowMs - lastLoudAt < SPEECH_HANGOVER_MS;

        // Gate ambient noise: only forward loud frames, plus a hangover window
        // after speech so Gemini's VAD can detect the end of the utterance.
        if (!aboveNoiseFloor && !inHangover) return;

        if (aboveNoiseFloor) lastUserInput = nowMs;

        const inEchoCooldown = nowMs - lastTtsAudioTime < TTS_ECHO_COOLDOWN_MS;
        const bargeInFrameEligible =
          inEchoCooldown &&
          modelIsSpeaking &&
          responseAudioStarted &&
          responseAudioStartedAt > 0 &&
          nowMs - responseAudioStartedAt >= DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS &&
          responseTtsBytes >= DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES &&
          rms >= TTS_BARGE_IN_RMS;
        if (bargeInFrameEligible) {
          ttsBargeInFrames += 1;
        } else {
          ttsBargeInFrames = 0;
        }
        const allowBargeInDuringTts = shouldAllowTtsBargeIn({
          inEchoCooldown,
          modelIsSpeaking,
          responseAudioStarted,
          ttsAudioStartedAt: responseAudioStartedAt,
          nowMs,
          responseTtsBytes,
          rms,
          thresholdRms: TTS_BARGE_IN_RMS,
          consecutiveFrames: ttsBargeInFrames,
          thresholdFrames: TTS_BARGE_IN_FRAME_COUNT,
        });

        if (allowBargeInDuringTts) {
          log.info(`Allowing TTS barge-in after sustained speech (rms=${Math.round(rms)})`);
          ttsBargeInFrames = 0;
          cancelOngoingResponse();
          send({ type: "interrupt" });
        }

        if (!inEchoCooldown || allowBargeInDuringTts) {
          lastAudioSentToGemini = nowMs;
          gAudio(pcm16k);
          if (aboveNoiseFloor) sendAudioToVolc(pcm16k);
        }
      } else if (msg.type === "text_input" && msg.content) {
        const text = (msg.content as string).trim();
        if (!text) return;
        lastUserInput = Date.now();
        pushHistory("user", text);
        if (tryHandleExplicitUserNavigation(text)) return;
        send({ type: "interrupt" });
        cancelOngoingResponse();
        scheduleDropReset();
        gSend(text);
      } else if (msg.type === "code_update") {
        const content = (msg.content as string) || "";
        const language = (msg.language as string) || "plaintext";
        latestCode = content;
        latestCodeLanguage = language;
        if (content) {
          // Context only — turnComplete:false so the model does NOT speak.
          gContext([{
            text: `[CODE_UPDATE] The participant's current code (${language}):\n\`\`\`${language}\n${content}\n\`\`\`\n(Do not respond to this update.)`,
          }]);
        }
      } else if (msg.type === "text" && msg.content) {
        scheduleDropReset();
        gSend(`[SYSTEM] Please say the following aloud: ${msg.content}`);
      } else if (msg.type === "whiteboard_update") {
        const imageDataUrl = (msg.imageDataUrl as string) || "";
        const m = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(imageDataUrl);
        if (m) {
          const ok = gContext([
            { text: "[WHITEBOARD_UPDATE] The participant's current whiteboard. (Do not respond to this update.)" },
            { inlineData: { mimeType: m[1], data: m[2] } },
          ]);
          if (ok) log.info("Whiteboard image sent to Gemini");
        }
      }
    } catch (err) {
      log.error("Error handling browser message:", err);
    }
  });

  browserWs.on("close", () => {
    log.info("Browser disconnected");
    browserClosed = true;
    clearInterval(keepaliveTimer);
    clearInterval(livenessTimer);
    clearPendingTransition();
    clearQuestionPrompt();
    clearDropState();
    cleanupVolcAsr();
    if (interviewCompleteTimer) clearTimeout(interviewCompleteTimer);
    connId++; // invalidate callbacks of the current session
    try { geminiSession?.close(); } catch { /* ignore */ }
    geminiSession = null;
  });

  browserWs.on("error", (err) => {
    log.error("Browser WS error:", err.message);
  });
}