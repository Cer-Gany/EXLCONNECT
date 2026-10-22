"use client";

import MediaPipeGuard from "@/components/proctoring/MediaPipeGuard";
import YoloObjectGuard from "@/components/proctoring/YoloObjectGuard";
import { useAudioGuard } from "@/hooks/use-audio-guard";
import type { AntiCheatingViolation } from "@/hooks/use-anti-cheating";
import { useAntiCheating, type RiskLevel } from "@/hooks/use-anti-cheating";
import { useToast } from "@/hooks/use-toast";
import { trpc } from "@/lib/trpc/client";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Mic,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";

interface AntiCheatingGuardProps {
  enabled: boolean;
  sessionId?: string;
  /** Pass the AI interviewer's speaking state so the audio guard can suppress
   *  false positives while TTS audio is playing through the speakers. */
  aiIsSpeaking?: boolean;
}

// ── Risk level → visual style mapping ─────────────────────────────────────────
const RISK_STYLES: Record<RiskLevel, { bg: string; text: string; label: string }> = {
  GREEN:  { bg: "bg-emerald-500", text: "text-emerald-300", label: "Low Risk"  },
  YELLOW: { bg: "bg-yellow-400",  text: "text-yellow-300",  label: "Caution"   },
  ORANGE: { bg: "bg-orange-500",  text: "text-orange-300",  label: "Warning"   },
  RED:    { bg: "bg-red-600",     text: "text-red-300",     label: "High Risk" },
};

export function AntiCheatingGuard({ enabled, sessionId, aiIsSpeaking = false }: AntiCheatingGuardProps) {
  const { toast } = useToast();
  const [warningOpen, setWarningOpen]             = useState(false);
  const [departureCount, setDepartureCount]       = useState(0);
  const [proctoringCollapsed, setProctoringCollapsed] = useState(true);
  const [cameraStream, setCameraStream]           = useState<MediaStream | null>(null);

  const lastDepartureTs   = useRef(0);
  const lastPasteToast    = useRef(0);
  const lastProctorToast  = useRef(0);
  const lastAudioToast    = useRef(0);

  const reportMutation = trpc.session.reportAntiCheatingViolation.useMutation();

  // ── Persist violation to backend ─────────────────────────────────────────────
  const persistViolation = useCallback(
    (violation: AntiCheatingViolation) => {
      if (!sessionId) return;
      reportMutation.mutate({
        sessionId,
        violation: {
          type: violation.type,
          timestamp: violation.timestamp,
          detail: violation.detail,
        },
      });
    },
    [sessionId, reportMutation],
  );

  // ── Risk level change callback ────────────────────────────────────────────────
  const handleRiskLevelChange = useCallback(
    (level: RiskLevel, score: number) => {
      if (level === "ORANGE" || level === "RED") {
        toast({
          title: (
            <span className={level === "RED" ? "text-red-500" : "text-orange-500"}>
              {level === "RED" ? "🚨 High Integrity Risk" : "⚠️ Elevated Risk Detected"}
            </span>
          ) as unknown as string,
          description:
            level === "RED"
              ? `Your proctoring risk score has reached ${score}. This session is flagged for review.`
              : `Multiple integrity signals detected (score: ${score}). Please ensure compliance.`,
        });
      }
    },
    [toast],
  );

  // ── Departure handler ─────────────────────────────────────────────────────────
  const recordDeparture = useCallback(() => {
    const now = Date.now();
    if (now - lastDepartureTs.current < 500) return;
    lastDepartureTs.current = now;
    setDepartureCount((prev) => prev + 1);
    setWarningOpen(true);
  }, []);

  // ── Violation dispatcher ──────────────────────────────────────────────────────
  const handleViolation = useCallback(
    (violation: AntiCheatingViolation) => {
      persistViolation(violation);

      switch (violation.type) {
        case "page_departure":
          recordDeparture();
          break;

        case "paste": {
          const now = Date.now();
          if (now - lastPasteToast.current < 3000) return;
          lastPasteToast.current = now;
          toast({
            title: (<span className="text-red-600 dark:text-red-400">External paste blocked</span>) as unknown as string,
            description: "Pasting content from outside the interview is not allowed.",
          });
          break;
        }

        case "multi_screen":
          toast({
            title: (<span className="text-red-600 dark:text-red-400">Additional display detected</span>) as unknown as string,
            description: "For the best experience, please use a single screen during this interview.",
          });
          break;

        case "suspicious_audio":
        case "loud_sound": {
          const now = Date.now();
          if (now - lastAudioToast.current < 8000) return;
          lastAudioToast.current = now;
          toast({
            title: (<span className="text-amber-600 dark:text-amber-400">🎤 Audio Alert</span>) as unknown as string,
            description:
              violation.type === "suspicious_audio"
                ? "Sustained speech detected. Please ensure you are alone and not reading answers aloud."
                : "Loud sound detected. Please maintain a quiet environment.",
          });
          break;
        }

        case "multiple_faces":
        case "face_not_visible":
        case "looking_away":
        case "gaze_off_screen":
        case "prohibited_object": {
          const now = Date.now();
          if (now - lastProctorToast.current < 8000) return;
          lastProctorToast.current = now;
          toast({
            title: (<span className="text-amber-600 dark:text-amber-400">Proctoring Notice</span>) as unknown as string,
            description:
              violation.detail ||
              "Please remain centered in front of your camera with no unauthorized items visible.",
          });
          break;
        }
      }
    },
    [toast, recordDeparture, persistViolation],
  );

  // ── Translate proctoring component string events to typed violations ──────────
  const handleProctoringViolation = useCallback(
    (reason: string) => {
      const lower = reason.toLowerCase();
      let type: AntiCheatingViolation["type"] = "looking_away";
      let detail = reason;

      if (lower.includes("multiple faces") || lower === "multiple_faces") {
        type = "multiple_faces";
        detail = "Multiple faces detected in the camera frame.";
      } else if (
        lower.includes("no face") ||
        lower.includes("not visible") ||
        lower === "face_not_visible" ||
        lower.includes("candidate missing")
      ) {
        type = "face_not_visible";
        detail = "Candidate face is not visible in the camera frame.";
      } else if (lower.includes("gaze") || lower === "gaze_off_screen") {
        type = "gaze_off_screen";
        detail = "Candidate gaze is directed away from the screen.";
      } else if (lower.includes("prohibited") || lower.includes("detected:") || lower === "prohibited_object") {
        type = "prohibited_object";
      } else if (lower === "looking_away") {
        type = "looking_away";
        detail = "Candidate appears to be looking away from the screen.";
      } else if (lower.includes("liveness") || lower === "no_blink_detected") {
        type = "face_not_visible";
        detail = "Liveness check failed — no blink detected. Possible spoofing.";
      }

      handleViolation({ type, timestamp: Date.now(), detail });
    },
    [handleViolation],
  );

  // ── Audio guard violation handler ─────────────────────────────────────────────
  const handleAudioViolation = useCallback(
    (type: "suspicious_audio" | "loud_sound", detail: string) => {
      handleViolation({ type, timestamp: Date.now(), detail });
    },
    [handleViolation],
  );

  // ── useAntiCheating hook (tab blur, paste, multi-screen) ──────────────────────
  const { riskScore, riskLevel } = useAntiCheating({
    enabled,
    onViolation: handleViolation,
    onRiskLevelChange: handleRiskLevelChange,
  });

  // ── Audio guard ───────────────────────────────────────────────────────────────
  useAudioGuard({
    enabled,
    onViolation: handleAudioViolation,
    existingStream: cameraStream,
    isSpeaking: aiIsSpeaking,
  });

  if (!enabled) return null;

  const riskStyle = RISK_STYLES[riskLevel];

  return (
    <>
      {/* ── Floating proctoring panel ───────────────────────────────────────── */}
      <div className="fixed bottom-4 left-4 z-40 w-64 rounded-xl border border-slate-200 bg-white/95 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        {/* Header / collapse toggle */}
        <button
          type="button"
          onClick={() => setProctoringCollapsed((prev) => !prev)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200"
        >
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            AI Proctoring Active
          </span>

          {/* Risk score badge */}
          <span className="flex items-center gap-1.5">
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${riskStyle.bg} text-white`}
              title={`Risk score: ${riskScore}`}
            >
              {riskStyle.label}
            </span>
            {proctoringCollapsed ? (
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
            )}
          </span>
        </button>

        {/* ── Guards: ALWAYS mounted regardless of collapse state ────────────
             The video element must have real dimensions for frames to be
             valid. We render guards outside the collapsed container and
             only hide them visually (opacity-0 + pointer-events-none +
             absolute positioning so they take no layout space). */}
        <div
          aria-hidden="true"
          className={`transition-all duration-200 overflow-hidden ${
            proctoringCollapsed
              ? "absolute opacity-0 pointer-events-none"
              : "flex flex-col gap-2 border-t border-slate-100 p-2 dark:border-slate-800"
          }`}
        >
          <MediaPipeGuard
            onViolation={handleProctoringViolation}
            onStreamReady={setCameraStream}
          />
          <YoloObjectGuard
            onObjectDetected={(obj) =>
              handleProctoringViolation(`Prohibited item detected: ${obj}`)
            }
          />

          {/* Audio monitor indicator */}
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-2 w-full flex items-center gap-2 mt-1">
            <Mic className="h-3 w-3 text-cyan-400 shrink-0" />
            <span className="text-[11px] text-slate-400">Audio monitoring active</span>
            <span className="ml-auto h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
          </div>

          {/* Score breakdown */}
          <div className="text-[10px] text-slate-500 text-center pt-1">
            Risk score: <span className={`font-bold ${riskStyle.text}`}>{riskScore}</span>
          </div>
        </div>
      </div>

      {/* ── Departure warning modal ─────────────────────────────────────────── */}
      {warningOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-2xl dark:border-red-900 dark:bg-gray-900">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/50">
                <AlertTriangle className="h-7 w-7 text-red-600 dark:text-red-400" />
              </div>

              <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
                Page departure detected
              </h2>

              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                You have left the interview page{" "}
                <span className="font-semibold text-red-600 dark:text-red-400">
                  {departureCount} {departureCount === 1 ? "time" : "times"}
                </span>
                . All departures are recorded and may be reviewed. Excessive
                departures could affect the evaluation of your session.
              </p>

              {departureCount >= 3 && (
                <div className="mt-3 w-full rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:bg-red-950/30 dark:text-red-300">
                  Warning: You have reached the maximum number of allowed
                  departures. Further departures will be flagged for review.
                </div>
              )}

              <button
                onClick={() => setWarningOpen(false)}
                className="mt-5 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:bg-red-700 dark:hover:bg-red-600"
              >
                I understand, continue interview
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
