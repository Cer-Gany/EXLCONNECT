/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { CodeBlock } from "@/components/code-editor/code-block";
import { useOrg } from "@/components/org-provider";
import { SessionRow, SessionsTable } from "@/components/session/sessions-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { getSessionOverallScore } from "@/lib/session-score";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Camera,
  ChevronDown,
  ChevronUp,
  Clock,
  Code2,
  EyeOff,
  FileDown,
  FileText,
  HelpCircle,
  Lightbulb,
  Loader2,
  Maximize2,
  MessageCircle,
  MessageSquare,
  Mic,
  Monitor,
  Pause,
  PenLine,
  Play,
  Radio,
  Search,
  SkipBack,
  SkipForward,
  SmilePlus,
  Sparkles,
  Tags,
  Target,
  UserCheck,
  Users,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const totalSec = Math.floor(seconds);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Video player that automatically resolves WebM Infinity-duration files by
 * probing the stream end on metadata load, and renders an always-seekable
 * timeline scrubber + current/total duration display + speed controls.
 */
function SeekableVideoPlayer({
  src,
  fallbackDurationSeconds,
}: {
  src: string;
  fallbackDurationSeconds?: number | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const probingDurationRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(
    fallbackDurationSeconds && fallbackDurationSeconds > 0
      ? fallbackDurationSeconds
      : 0,
  );
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (
      fallbackDurationSeconds &&
      fallbackDurationSeconds > 0 &&
      duration <= 0
    ) {
      setDuration(fallbackDurationSeconds);
    }
  }, [fallbackDurationSeconds, duration]);

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Number.isFinite(v.duration) && v.duration > 0 && v.duration < 1e7) {
      setDuration(v.duration);
      setIsReady(true);
    } else if (!probingDurationRef.current) {
      // Browser opened a WebM without an EBML Duration header (v.duration === Infinity).
      // Seek to a huge timestamp so the browser indexes the byte range and computes real duration.
      probingDurationRef.current = true;
      v.currentTime = 1e101;
    }
  }, []);

  const handleDurationChange = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Number.isFinite(v.duration) && v.duration > 0 && v.duration < 1e7) {
      setDuration(v.duration);
      if (probingDurationRef.current) {
        probingDurationRef.current = false;
        v.currentTime = 0;
        setCurrentTime(0);
      }
      setIsReady(true);
    }
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (probingDurationRef.current) {
      if (Number.isFinite(v.duration) && v.duration > 0 && v.duration < 1e7) {
        setDuration(v.duration);
      } else if (v.currentTime > 0 && v.currentTime < 1e7) {
        setDuration(v.currentTime);
      }
      probingDurationRef.current = false;
      v.currentTime = 0;
      setCurrentTime(0);
      setIsReady(true);
      return;
    }
    setCurrentTime(v.currentTime);
    if (
      Number.isFinite(v.duration) &&
      v.duration > 0 &&
      v.duration < 1e7 &&
      Math.abs(v.duration - duration) > 0.5
    ) {
      setDuration(v.duration);
    } else if (v.currentTime > duration) {
      setDuration(v.currentTime);
    }
  }, [duration]);

  const effectiveDuration = Math.max(
    duration,
    fallbackDurationSeconds ?? 0,
    currentTime,
    1,
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || probingDurationRef.current) return;
    if (v.paused) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

  const seekTo = useCallback(
    (targetSec: number) => {
      const v = videoRef.current;
      if (!v || probingDurationRef.current) return;
      const clamped = Math.max(0, Math.min(effectiveDuration, targetSec));
      v.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [effectiveDuration],
  );

  const cycleSpeed = useCallback(() => {
    const speeds = [1, 1.25, 1.5, 2];
    const next = speeds[(speeds.indexOf(playbackRate) + 1) % speeds.length];
    setPlaybackRate(next);
    if (videoRef.current) {
      videoRef.current.playbackRate = next;
    }
  }, [playbackRate]);

  const handleFullscreen = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.requestFullscreen) {
      void v.requestFullscreen();
    }
  }, []);

  return (
    <div className="overflow-hidden rounded-lg border bg-zinc-950">
      <video
        ref={videoRef}
        controls
        preload="auto"
        src={src}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleDurationChange}
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        className="max-h-[540px] w-full bg-black object-contain"
      />
      {/* Always-available custom timeline scrubber & exact duration bar */}
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-200">
        <button
          type="button"
          onClick={togglePlay}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-800 hover:bg-zinc-700 transition-colors"
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </button>

        <button
          type="button"
          onClick={() => seekTo(currentTime - 10)}
          className="flex items-center gap-0.5 rounded px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          title="Rewind 10 seconds"
        >
          <SkipBack className="h-3 w-3" />
          <span>10s</span>
        </button>

        <button
          type="button"
          onClick={() => seekTo(currentTime + 10)}
          className="flex items-center gap-0.5 rounded px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          title="Forward 10 seconds"
        >
          <span>10s</span>
          <SkipForward className="h-3 w-3" />
        </button>

        <span className="font-mono text-[11px] tabular-nums text-zinc-300 shrink-0">
          {formatMediaTime(currentTime)}{" "}
          <span className="text-zinc-500">/</span>{" "}
          {isReady || duration > 0
            ? formatMediaTime(effectiveDuration)
            : "Loading..."}
        </span>

        <input
          type="range"
          min={0}
          max={effectiveDuration}
          step={0.1}
          value={Math.min(currentTime, effectiveDuration)}
          onChange={(e) => seekTo(parseFloat(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer accent-primary"
          aria-label="Seek video timeline"
        />

        <button
          type="button"
          onClick={cycleSpeed}
          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-200 hover:bg-zinc-700"
          title="Playback speed"
        >
          {playbackRate}x
        </button>

        <button
          type="button"
          onClick={handleFullscreen}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-800 hover:bg-zinc-700 transition-colors"
          title="Fullscreen"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

interface QuestionEvaluation {
  question: string;
  score: number;
  evaluation: string;
  highlights?: string[];
  improvements?: string[];
}

interface ResearchFinding {
  question: string;
  summary: string;
  keyTopics?: { topic: string; details: string }[];
  dataPoints?: string[];
}

export function InterviewResults({
  interviewId,
  initialSessionId,
  onBack: externalOnBack,
}: {
  interviewId: string;
  initialSessionId?: string;
  onBack?: () => void;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const utils = trpc.useUtils();

  const sessions = trpc.session.listByInterview.useQuery(
    {
      interviewId,
      limit: 100,
    },
    {
      refetchInterval: 5000,
    },
  );
  const insights = trpc.analysis.getInterviewInsights.useQuery({ interviewId });

  if (selectedSessionId) {
    return (
      <SessionDetail
        sessionId={selectedSessionId}
        onBack={() => {
          if (externalOnBack) {
            externalOnBack();
          } else {
            setSelectedSessionId(null);
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-4 p-6">
            <Users className="h-8 w-8 text-primary" />
            <div>
              <p className="text-sm text-muted-foreground">Total Sessions</p>
              <p className="text-2xl font-bold">
                {insights.data?.totalSessions ?? 0}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-6">
            <UserCheck className="h-8 w-8 text-primary" />
            <div>
              <p className="text-sm text-muted-foreground">Participants</p>
              <p className="text-2xl font-bold">
                {insights.data?.totalParticipants ?? 0}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-6">
            <Clock className="h-8 w-8 text-primary" />
            <div>
              <p className="text-sm text-muted-foreground">Avg Duration</p>
              <p className="text-2xl font-bold">
                {insights.data?.avgDurationSeconds
                  ? `${Math.round(insights.data.avgDurationSeconds / 60)}m`
                  : "N/A"}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-6">
            <BarChart3 className="h-8 w-8 text-primary" />
            <div>
              <p className="text-sm text-muted-foreground">Top Themes</p>
              <p className="text-lg font-bold">
                {insights.data?.topThemes?.length ?? 0}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sessions Table */}
      <SessionsTable
        sessions={(sessions.data?.sessions ?? []) as SessionRow[]}
        isLoading={sessions.isLoading}
        onSessionClick={(s) => setSelectedSessionId(s.id)}
        onDeleteSuccess={() => {
          utils.session.listByInterview.invalidate({ interviewId });
          utils.analysis.getInterviewInsights.invalidate({ interviewId });
        }}
        emptyMessage="No sessions yet. Share the interview link to start collecting responses."
      />

      {/* Themes */}
      {insights.data?.topThemes && insights.data.topThemes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Top Themes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {insights.data.topThemes.map(([theme, count]) => (
                <Badge key={theme} variant="outline" className="text-sm">
                  {theme} ({count})
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SessionDetail({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const { currentOrg } = useOrg();
  const summary = trpc.analysis.getSessionSummary.useQuery(
    { sessionId },
    {
      refetchInterval: (data: any, query?: any) =>
        (data?.status ?? query?.state?.data?.status) === "IN_PROGRESS"
          ? 2500
          : false,
    },
  );
  const isOngoing = summary.data?.status === "IN_PROGRESS";
  const liveStateQuery = trpc.session.getLiveState.useQuery(
    { sessionId },
    {
      enabled: isOngoing,
      refetchInterval: isOngoing ? 1200 : false,
    },
  );
  const liveState = liveStateQuery.data;
  const completeSession = trpc.session.complete.useMutation();
  const [generating, setGenerating] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  // Auto-open transcript when watching an ongoing live session
  useEffect(() => {
    if (isOngoing) {
      setTranscriptOpen(true);
    }
  }, [isOngoing]);
  const [exporting, setExporting] = useState(false);
  const [pdfCapture, setPdfCapture] = useState(false);
  const [lightboxImg, setLightboxImg] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  const [exportProgress, setExportProgress] = useState("");
  const [exportPercent, setExportPercent] = useState(0);
  const reportRef = useRef<HTMLDivElement>(null);

  const handleGenerateSummary = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/ai/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, organizationId: currentOrg?.id }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || "Failed to generate summary");
      }
      await summary.refetch();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to generate summary";
      toast({
        title: "Summary generation failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  }, [sessionId, summary, currentOrg?.id, toast]);

  const handleRequestReport = useCallback(() => {
    if (summary.data?.status === "IN_PROGRESS") {
      setShowEndConfirm(true);
    } else {
      handleGenerateSummary();
    }
  }, [summary.data?.status, handleGenerateSummary]);

  const handleConfirmEndAndGenerate = useCallback(async () => {
    try {
      await completeSession.mutateAsync({ id: sessionId });
      await summary.refetch();
    } catch {
      toast({ title: "Failed to end interview", variant: "destructive" });
      return;
    }
    handleGenerateSummary();
  }, [sessionId, completeSession, summary, handleGenerateSummary, toast]);

  // Auto-generate report for completed sessions that have no summary yet
  const autoTriggered = useRef(false);
  useEffect(() => {
    if (
      !autoTriggered.current &&
      !summary.isLoading &&
      summary.data &&
      summary.data.status === "COMPLETED" &&
      !summary.data.summary &&
      (summary.data.messages?.length ?? 0) > 0
    ) {
      autoTriggered.current = true;
      handleGenerateSummary();
    }
  }, [summary.isLoading, summary.data, handleGenerateSummary]);

  const handleExportPDF = useCallback(async () => {
    if (!reportRef.current) return;

    const participant =
      summary.data?.participantName ||
      summary.data?.participantEmail ||
      "anonymous";
    const title = summary.data?.interviewTitle || "interview";
    const fileName = `${title.replace(/\s+/g, "_")}_${participant.replace(/\s+/g, "_")}_report.pdf`;

    // Let user choose save location first (Chrome/Edge)

    let fileHandle: any = null;
    try {
      if ("showSaveFilePicker" in window) {

        fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: fileName,
          types: [
            {
              description: "PDF Document",
              accept: { "application/pdf": [".pdf"] },
            },
          ],
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }

    setExporting(true);
    setExportPercent(0);
    setExportProgress("Preparing...");
    setPdfCapture(true);
    await new Promise((r) => setTimeout(r, 150));

    // Yield to let the browser paint before each heavy stage
    const paint = () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );

    // Animate progress during the slow html2canvas phase
    let animPct = 5;
    const timer = setInterval(() => {
      animPct += (75 - animPct) * 0.04;
      setExportPercent(Math.round(animPct));
    }, 200);

    try {
      setExportProgress("Rendering...");
      setExportPercent(5);
      await paint();

      const html2canvas = (await import("html2canvas-pro")).default;
      const { jsPDF } = await import("jspdf");

      const canvas = await html2canvas(reportRef.current, {
        scale: 2.0,
        useCORS: true,
        backgroundColor: "#ffffff",
        imageTimeout: 60000,
        logging: false,
      });
      clearInterval(timer);

      setExportProgress("Building PDF...");
      setExportPercent(80);
      await paint();

      const imgWidth = 190;
      const pageHeight = 277;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      const imgData = canvas.toDataURL("image/jpeg", 0.92);

      setExportPercent(90);
      await paint();

      const pdf = new jsPDF("p", "mm", "a4");
      let heightLeft = imgHeight;
      let position = 10;

      pdf.addImage(imgData, "JPEG", 10, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      while (heightLeft > 0) {
        position = heightLeft - imgHeight + 10;
        pdf.addPage();
        pdf.addImage(imgData, "JPEG", 10, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      setExportProgress("Saving...");
      setExportPercent(95);
      await paint();

      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(pdf.output("blob"));
        await writable.close();
      } else {
        pdf.save(fileName);
      }
      setExportPercent(100);
    } catch (err) {
      console.error("PDF export failed:", err);
    } finally {
      clearInterval(timer);
      setPdfCapture(false);
      setExporting(false);
      setExportProgress("");
      setExportPercent(0);
    }
  }, [summary.data]);

  // Parse insights data
  const insightsData = summary.data?.insights as
    | {
        keyInsights?: string[];
        criteriaEvaluations?: {
          name: string;
          score: number;
          reasoning: string;
        }[];
        questionEvaluations?: QuestionEvaluation[];
        researchFindings?: ResearchFinding[];
        toneAnalysis?: {
          overall?: string;
          details?: string;
          segments?: {
            question: string;
            tone: string;
            confidence: string;
            notes: string;
          }[];
        };
      }
    | string[]
    | null;
  const keyInsights = Array.isArray(insightsData)
    ? insightsData
    : (insightsData?.keyInsights ?? []);
  const criteriaEvaluations = Array.isArray(insightsData)
    ? []
    : (insightsData?.criteriaEvaluations ?? []);
  const questionEvaluations: QuestionEvaluation[] = Array.isArray(insightsData)
    ? []
    : (insightsData?.questionEvaluations ?? []);
  const researchFindings: ResearchFinding[] = Array.isArray(insightsData)
    ? []
    : (insightsData?.researchFindings ?? []);
  const toneAnalysis = Array.isArray(insightsData)
    ? null
    : (insightsData?.toneAnalysis ?? null);

  const sentimentData = summary.data?.sentiment as {
    overall?: string;
    details?: string;
  } | null;

  const antiCheatingLog = (summary.data?.antiCheatingLog ?? []) as {
    type: string;
    timestamp: number;
    detail?: string;
  }[];

  const hasReport = !!(
    summary.data?.summary ||
    criteriaEvaluations.length > 0 ||
    questionEvaluations.length > 0 ||
    researchFindings.length > 0 ||
    keyInsights.length > 0 ||
    (summary.data?.themes && summary.data.themes.length > 0)
  );

  const overallScore = getSessionOverallScore({
    questionEvaluations,
    criteriaEvaluations,
  });
  const avgQuestionScore =
    overallScore !== null ? overallScore.toFixed(1) : null;

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between no-print">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Results
        </Button>
        {hasReport && (
          <Button
            variant="outline"
            onClick={handleExportPDF}
            disabled={exporting}
            className="relative overflow-hidden"
          >
            {exporting && (
              <div
                className="absolute inset-0 bg-primary/10 transition-all duration-300 ease-out"
                style={{ width: `${exportPercent}%` }}
              />
            )}
            <span className="relative flex items-center">
              {exporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="mr-2 h-4 w-4" />
              )}
              {exporting ? exportProgress || "Exporting..." : "Export PDF"}
            </span>
          </Button>
        )}
      </div>

      {summary.isLoading ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          {/* Report area — this div is captured for PDF */}
          <div
            ref={reportRef}
            className={cn(
              "space-y-6 bg-background",
              pdfCapture && "pdf-capture",
            )}
          >
            {/* Report header */}
            {(() => {
              const screenshots = summary.data?.screenshots as
                | {
                    url: string;
                    path: string;
                    timestamp: string;
                    type: "camera" | "screen";
                  }[]
                | null;
              const avatarUrl =
                screenshots?.find((s) => s.type === "camera")?.url ?? null;
              const participantName =
                summary.data?.participantName ||
                summary.data?.participantEmail ||
                "Anonymous";

              return (
                <div className="space-y-4">
                  <h1 className="text-2xl font-bold">
                    {summary.data?.interviewTitle ?? "Interview"} — Session
                    Report
                  </h1>

                  <div className="flex flex-col items-stretch gap-4 sm:flex-row">
                    {/* Profile card */}
                    <Card className="flex-1">
                      <CardContent className="flex h-full items-center gap-5 p-5">
                        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border-2 border-muted bg-muted">
                          {avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={avatarUrl}
                              alt={participantName}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-muted-foreground">
                              {participantName.charAt(0).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-lg font-semibold">
                              {participantName}
                            </p>
                            {summary.data?.status && (
                              <Badge
                                variant={
                                  summary.data.status === "COMPLETED"
                                    ? "default"
                                    : "secondary"
                                }
                              >
                                {summary.data.status}
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                            {summary.data?.createdAt && (
                              <span className="flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5" />
                                {new Date(
                                  summary.data.createdAt,
                                ).toLocaleDateString(undefined, {
                                  year: "numeric",
                                  month: "long",
                                  day: "numeric",
                                })}
                              </span>
                            )}
                            {summary.data?.totalDurationSeconds != null && (
                              <span className="flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5" />
                                {Math.round(
                                  summary.data.totalDurationSeconds / 60,
                                )}{" "}
                                min
                              </span>
                            )}
                            {summary.data?.messages && (
                              <span className="flex items-center gap-1">
                                <MessageCircle className="h-3.5 w-3.5" />
                                {summary.data.messages.length} messages
                              </span>
                            )}
                          </div>
                          {summary.data?.interviewObjective && (
                            <p className="text-xs text-muted-foreground/80">
                              <span className="font-medium text-muted-foreground">
                                Objective:
                              </span>{" "}
                              {summary.data.interviewObjective}
                            </p>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Score card */}
                    {avgQuestionScore && (
                      <Card className="shrink-0 sm:w-40">
                        <CardContent className="flex h-full flex-col items-center justify-center p-5">
                          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
                            Avg Score
                          </p>
                          <div className="relative mt-2 flex h-24 w-24 items-center justify-center">
                            <svg
                              className="absolute inset-0 h-full w-full -rotate-90"
                              viewBox="0 0 100 100"
                            >
                              <circle
                                cx="50"
                                cy="50"
                                r="42"
                                fill="none"
                                stroke="hsl(var(--muted))"
                                strokeWidth="8"
                              />
                              <circle
                                cx="50"
                                cy="50"
                                r="42"
                                fill="none"
                                stroke={
                                  parseFloat(avgQuestionScore) >= 7
                                    ? "hsl(142, 60%, 45%)"
                                    : parseFloat(avgQuestionScore) >= 4
                                      ? "hsl(24, 80%, 55%)"
                                      : "hsl(var(--destructive))"
                                }
                                strokeWidth="8"
                                strokeLinecap="round"
                                strokeDasharray={`${parseFloat(avgQuestionScore) * 10 * 2.64} 264`}
                              />
                            </svg>
                            <span className="text-2xl font-bold">
                              {avgQuestionScore}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            out of 10
                          </p>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                </div>
              );
            })()}

            <Separator />

            {/* Live One-Way Recruiter Monitor for ongoing interviews */}
            {isOngoing && (() => {
              const screenshots = summary.data?.screenshots as
                | {
                    url: string;
                    path: string;
                    timestamp: string;
                    type: "camera" | "screen";
                  }[]
                | null;
              const latestCamShot = screenshots
                ?.filter((s) => s.type === "camera")
                .slice(-1)[0]?.url;
              const latestScreenShot = screenshots
                ?.filter((s) => s.type === "screen")
                .slice(-1)[0]?.url;

              const liveCameraSrc = liveState?.cameraFrame || latestCamShot;
              const liveScreenSrc = liveState?.screenFrame || latestScreenShot;
              const aiStatusText =
                liveState?.aiState === "speaking"
                  ? "AI Interviewer Speaking"
                  : liveState?.aiState === "listening"
                    ? "Listening to Candidate"
                    : liveState?.aiState === "thinking"
                      ? "AI Thinking..."
                      : liveState?.aiState === "transitioning"
                        ? "Moving to Next Question..."
                        : "Session Active";

              return (
                <Card className="border-emerald-500/40 bg-emerald-950/5 dark:bg-emerald-950/20 shadow-lg">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="flex items-center gap-2.5 text-base">
                        <span className="relative flex h-3 w-3">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                        </span>
                        <Radio className="h-4 w-4 text-emerald-500" />
                        Live Interview Monitor
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 text-xs"
                        >
                          <EyeOff className="h-3.5 w-3.5" />
                          Stealth Mode: Candidate cannot see or hear you
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Live status & current question banner */}
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/80 px-3.5 py-2.5 text-xs">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="capitalize">
                          {aiStatusText}
                        </Badge>
                        {liveState?.activeTool && (
                          <Badge variant="outline" className="uppercase text-[10px]">
                            Active View: {liveState.activeTool}
                          </Badge>
                        )}
                      </div>
                      {liveState?.currentQuestionText && (
                        <p className="truncate max-w-xl text-muted-foreground font-medium">
                          Q{(liveState.currentQuestionIndex ?? 0) + 1}:{" "}
                          {liveState.currentQuestionText}
                        </p>
                      )}
                    </div>

                    {/* Live Camera & Screen Feeds */}
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="overflow-hidden rounded-lg border bg-zinc-950">
                        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
                          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                            <Camera className="h-3.5 w-3.5 text-emerald-400" />
                            Candidate Camera (Live)
                          </span>
                          <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            Live
                          </span>
                        </div>
                        <div className="flex h-64 items-center justify-center bg-black">
                          {liveCameraSrc ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={liveCameraSrc}
                              alt="Live candidate camera"
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-2 text-xs text-zinc-500">
                              <Camera className="h-6 w-6 opacity-40" />
                              <span>Waiting for candidate camera stream...</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="overflow-hidden rounded-lg border bg-zinc-950">
                        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
                          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                            <Monitor className="h-3.5 w-3.5 text-emerald-400" />
                            Candidate Screen (Live)
                          </span>
                          <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            Live
                          </span>
                        </div>
                        <div className="flex h-64 items-center justify-center bg-black">
                          {liveScreenSrc ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={liveScreenSrc}
                              alt="Live candidate screen"
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-2 text-xs text-zinc-500">
                              <Monitor className="h-6 w-6 opacity-40" />
                              <span>Waiting for candidate screen share...</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Live Chat & Conversation Transcript (Recruiter Only) */}
                    {(() => {
                      const dbMessages = (summary.data?.messages ?? [])
                        .filter(
                          (m: any) =>
                            m.contentType !== "WHITEBOARD" &&
                            (m.contentType as string) !== "CODE",
                        )
                        .map((m: any) => ({
                          id: String(m.id),
                          role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
                          content: String(m.content ?? ""),
                          source: m.transcription === "chat" ? ("chat" as const) : ("voice" as const),
                        }));
                      const liveMessages: Array<{
                        id: string;
                        role: "user" | "assistant";
                        content: string;
                        source?: "voice" | "chat";
                      }> =
                        liveState?.messages && liveState.messages.length >= dbMessages.length
                          ? liveState.messages
                          : dbMessages;

                      return (
                        <div className="overflow-hidden rounded-lg border bg-card">
                          <div className="flex items-center justify-between border-b bg-muted/40 px-3.5 py-2">
                            <span className="flex items-center gap-2 text-xs font-semibold">
                              <MessageCircle className="h-3.5 w-3.5 text-emerald-500" />
                              Live Chat &amp; Conversation (Recruiter Only)
                            </span>
                            <Badge variant="secondary" className="text-[10px]">
                              {liveMessages.length}{" "}
                              {liveMessages.length === 1 ? "message" : "messages"}
                            </Badge>
                          </div>
                          <ScrollArea className="h-64">
                            <div className="space-y-3 p-3.5">
                              {liveMessages.length === 0 &&
                                !liveState?.aiTranscript &&
                                !liveState?.userTranscript && (
                                  <p className="py-8 text-center text-xs text-muted-foreground">
                                    Live conversation will appear here as the interview progresses...
                                  </p>
                                )}
                              {liveMessages.map((msg) => {
                                const isUser = msg.role === "user";
                                return (
                                  <div
                                    key={msg.id}
                                    className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}
                                  >
                                    <div
                                      className={`max-w-[78%] rounded-lg px-3.5 py-2 text-xs ${
                                        isUser
                                          ? "bg-primary text-primary-foreground"
                                          : "bg-secondary-100 dark:bg-secondary text-secondary-900 dark:text-secondary-foreground"
                                      }`}
                                    >
                                      <div className="mb-0.5 flex items-center gap-1.5 font-semibold opacity-80">
                                        {isUser ? (
                                          msg.source === "chat" ? (
                                            <MessageSquare className="h-3 w-3" />
                                          ) : (
                                            <Mic className="h-3 w-3" />
                                          )
                                        ) : (
                                          <Volume2 className="h-3 w-3" />
                                        )}
                                        <span>{isUser ? "Candidate" : "AI Interviewer"}</span>
                                      </div>
                                      <p className="leading-relaxed">{msg.content}</p>
                                    </div>
                                  </div>
                                );
                              })}
                              {liveState?.aiTranscript && (
                                <div className="flex gap-2.5">
                                  <div className="max-w-[78%] rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3.5 py-2 text-xs">
                                    <div className="mb-0.5 flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
                                      <Volume2 className="h-3 w-3 animate-pulse" />
                                      <span>AI Interviewer (Speaking Live)</span>
                                    </div>
                                    <p className="leading-relaxed text-muted-foreground">
                                      {liveState.aiTranscript}
                                    </p>
                                  </div>
                                </div>
                              )}
                              {liveState?.userTranscript && (
                                <div className="flex flex-row-reverse gap-2.5">
                                  <div className="max-w-[78%] rounded-lg border border-primary/30 bg-primary/10 px-3.5 py-2 text-xs">
                                    <div className="mb-0.5 flex items-center gap-1.5 font-semibold text-primary">
                                      <Mic className="h-3 w-3 animate-pulse" />
                                      <span>Candidate (Speaking Live)</span>
                                    </div>
                                    <p className="leading-relaxed text-foreground">
                                      {liveState.userTranscript}
                                    </p>
                                  </div>
                                </div>
                              )}
                            </div>
                          </ScrollArea>
                        </div>
                      );
                    })()}

                    {/* Live Code Editor View if candidate is writing code */}
                    {liveState?.codeSnippet?.code && (
                      <div className="overflow-hidden rounded-lg border bg-zinc-950">
                        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
                          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                            <Code2 className="h-3.5 w-3.5 text-emerald-400" />
                            Live Code Editor ({liveState.codeSnippet.language})
                          </span>
                        </div>
                        <CodeBlock
                          code={liveState.codeSnippet.code}
                          language={liveState.codeSnippet.language}
                          className="max-h-60 text-xs"
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            {/* Generate report if no summary yet */}
            {!summary.data?.summary && (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-12">
                  {generating ? (
                    <>
                      <Loader2 className="mb-3 h-8 w-8 animate-spin text-primary" />
                      <p className="mb-1 font-medium">Generating Report...</p>
                      <p className="text-sm text-muted-foreground">
                        Analyzing the interview result. This may take a moment.
                      </p>
                    </>
                  ) : (
                    <>
                      <Sparkles className="mb-3 h-8 w-8 text-muted-foreground" />
                      <p className="mb-1 font-medium">
                        No report generated yet
                      </p>
                      <p className="mb-4 text-sm text-muted-foreground">
                        Generate an AI-powered analysis of this interview
                        session.
                      </p>
                      <Button
                        onClick={handleRequestReport}
                        disabled={!(summary.data?.messages?.length ?? 0)}
                      >
                        <Sparkles className="mr-2 h-4 w-4" />
                        Generate Report
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Summary */}
            {summary.data?.summary && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Summary
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-line text-sm leading-relaxed">
                    {summary.data.summary}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Per-Question Evaluations */}
            {questionEvaluations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <HelpCircle className="h-4 w-4" />
                    Question-by-Question Evaluation
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {questionEvaluations.map((qe, i) => {
                    const toDisplayList = (value: unknown): string[] => {
                      if (Array.isArray(value)) {
                        return value
                          .filter((item) => item !== null && item !== undefined)
                          .map((item) =>
                            typeof item === "string" ? item : JSON.stringify(item),
                          );
                      }
                      if (typeof value === "string" && value.trim()) {
                        return [value];
                      }
                      if (value && typeof value === "object") {
                        return Object.values(value as Record<string, unknown>)
                          .filter(
                            (item) =>
                              typeof item === "string" ||
                              typeof item === "number",
                          )
                          .map(String);
                      }
                      return [];
                    };

                    const highlights = toDisplayList(qe.highlights);
                    const improvements = toDisplayList(qe.improvements);

                    return (
                    <div key={i} className="space-y-3 rounded-lg border p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <p className="text-sm font-medium">
                            Q{i + 1}. {qe.question}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-lg font-bold">
                            {qe.score}/10
                          </span>
                        </div>
                      </div>
                      <Progress value={(qe.score || 0) * 10} className="h-2" />
                      <p className="text-sm text-muted-foreground">
                        {qe.evaluation}
                      </p>
                      <div className="grid gap-4 sm:grid-cols-2">
                        {highlights.length > 0 && (
                          <div>
                            <p className="mb-1 text-xs font-medium text-secondary-600 dark:text-secondary-400">
                              Strengths
                            </p>
                            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                              {highlights.map((h, j) => (
                                <li key={j}>{String(h)}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {improvements.length > 0 && (
                          <div>
                            <p className="mb-1 text-xs font-medium text-tertiary-600 dark:text-tertiary-300">
                              Areas for Improvement
                            </p>
                            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                              {improvements.map((imp, j) => (
                                <li key={j}>{String(imp)}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}

            {/* Assessment Scores */}
            {criteriaEvaluations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Target className="h-4 w-4" />
                    Assessment Scores
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {criteriaEvaluations.map((ce, i) => (
                    <div key={i} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{ce.name}</span>
                        <span className="text-sm font-bold">{ce.score}/10</span>
                      </div>
                      <Progress value={ce.score * 10} className="h-2" />
                      <p className="text-xs text-muted-foreground">
                        {ce.reasoning}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Research Findings */}
            {researchFindings.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Search className="h-4 w-4" />
                    Research Findings
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {researchFindings.map((rf, i) => (
                    <div key={i} className="space-y-3 rounded-lg border p-4">
                      <p className="text-sm font-medium">{rf.question}</p>
                      <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                        {rf.summary}
                      </p>
                      {rf.keyTopics && rf.keyTopics.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-secondary-600 dark:text-secondary-400">
                            Key Topics
                          </p>
                          {rf.keyTopics.map((kt, j) => (
                            <div key={j} className="rounded-md bg-muted/50 p-3">
                              <p className="text-xs font-semibold">
                                {kt.topic}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {kt.details}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                      {rf.dataPoints && rf.dataPoints.length > 0 && (
                        <div>
                          <p className="mb-1 text-xs font-medium text-tertiary-600 dark:text-tertiary-300">
                            Key Data Points
                          </p>
                          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                            {rf.dataPoints.map((dp, j) => (
                              <li key={j}>{String(dp)}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Tone & Communication */}
            {toneAnalysis &&
              (toneAnalysis.details ||
                (toneAnalysis.segments &&
                  toneAnalysis.segments.length > 0)) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Volume2 className="h-4 w-4" />
                      Tone &amp; Communication
                      {toneAnalysis.overall && (
                        <Badge variant="outline" className="ml-auto capitalize">
                          {toneAnalysis.overall}
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {toneAnalysis.details && (
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {toneAnalysis.details}
                      </p>
                    )}
                    {toneAnalysis.segments &&
                      toneAnalysis.segments.length > 0 && (
                        <div className="space-y-3">
                          {toneAnalysis.segments.map((seg, i) => (
                            <div
                              key={i}
                              className="rounded-lg border p-3 space-y-1"
                            >
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium truncate max-w-[70%]">
                                  {seg.question}
                                </p>
                                <div className="flex gap-2">
                                  <Badge
                                    variant="outline"
                                    className="capitalize text-xs"
                                  >
                                    {seg.tone}
                                  </Badge>
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "text-xs capitalize",
                                      seg.confidence === "high" &&
                                        "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400",
                                      seg.confidence === "low" &&
                                        "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400",
                                    )}
                                  >
                                    {seg.confidence}
                                  </Badge>
                                </div>
                              </div>
                              {seg.notes && (
                                <p className="text-xs text-muted-foreground">
                                  {seg.notes}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                  </CardContent>
                </Card>
              )}

            {/* Key Insights + Themes + Sentiment */}
            {(keyInsights.length > 0 ||
              (summary.data?.themes && summary.data.themes.length > 0) ||
              sentimentData) && (
              <div className="grid gap-6 md:grid-cols-3">
                {keyInsights.length > 0 && (
                  <Card
                    className={
                      !sentimentData &&
                      (!summary.data?.themes ||
                        summary.data.themes.length === 0)
                        ? "md:col-span-3"
                        : ""
                    }
                  >
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Lightbulb className="h-4 w-4" />
                        Key Insights
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="list-disc space-y-1.5 pl-4 text-sm">
                        {keyInsights.map((insight, i) => (
                          <li key={i}>{String(insight)}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}

                {summary.data?.themes && summary.data.themes.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Tags className="h-4 w-4" />
                        Themes
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-2">
                        {summary.data.themes.map((theme: string) => (
                          <Badge key={theme} variant="outline">
                            {theme}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {sentimentData && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <SmilePlus className="h-4 w-4" />
                          Sentiment
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "capitalize",
                            sentimentData.overall === "positive"
                              ? "border-secondary-200 bg-secondary-50 text-secondary-700 dark:border-secondary-800 dark:bg-secondary-900/30 dark:text-secondary-300"
                              : sentimentData.overall === "negative"
                                ? "border-destructive-200 bg-destructive-50 text-destructive-700 dark:border-destructive-800 dark:bg-destructive-900/30 dark:text-destructive-300"
                                : "border-tertiary-200 bg-tertiary-50 text-tertiary-700 dark:border-tertiary-800 dark:bg-tertiary-900/30 dark:text-tertiary-300",
                          )}
                        >
                          {sentimentData.overall ?? "N/A"}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    {sentimentData.details && (
                      <CardContent>
                        <p className="text-sm text-muted-foreground">
                          {sentimentData.details}
                        </p>
                      </CardContent>
                    )}
                  </Card>
                )}
              </div>
            )}

            {/* Whiteboard — shown if any whiteboard messages exist */}
            {(() => {
              const whiteboardMsgs = summary.data?.messages.filter(
                (m: any) =>
                  m.contentType === "WHITEBOARD" && m.whiteboardImageUrl,
              );
              if (!whiteboardMsgs || whiteboardMsgs.length === 0) return null;
              return (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <PenLine className="h-4 w-4" />
                      Whiteboard
                      <Badge variant="secondary" className="ml-1 font-normal">
                        {whiteboardMsgs.length}{" "}
                        {whiteboardMsgs.length === 1 ? "drawing" : "drawings"}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {whiteboardMsgs.map((msg: any) => {
                        const label = (
                          msg.whiteboardData as Record<string, unknown> | null
                        )?.label as string | undefined;
                        const alt = label ?? "Whiteboard drawing";
                        return (
                          <button
                            key={msg.id}
                            type="button"
                            className="group overflow-hidden rounded-lg border bg-card p-1.5 text-left transition-shadow hover:shadow-md hover:ring-1 hover:ring-primary/30"
                            onClick={() =>
                              setLightboxImg({
                                src: msg.whiteboardImageUrl!,
                                alt,
                              })
                            }
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={msg.whiteboardImageUrl!}
                              alt={alt}
                              className="h-44 w-full rounded object-contain"
                            />
                            <div className="mt-1 flex items-center justify-between px-0.5">
                              {label && (
                                <p className="truncate text-[11px] font-medium text-muted-foreground">
                                  {label}
                                </p>
                              )}
                              <p className="ml-auto text-[10px] text-muted-foreground/60">
                                {new Date(msg.timestamp).toLocaleTimeString(
                                  undefined,
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            {/* Anti-cheating integrity log */}
            {antiCheatingLog.length > 0 && (
              <Card className="border-amber-200 dark:border-amber-900">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    Integrity Log
                    <Badge variant="outline" className="ml-1 font-normal">
                      {antiCheatingLog.length}{" "}
                      {antiCheatingLog.length === 1 ? "event" : "events"}
                    </Badge>
                  </CardTitle>
                </CardHeader>

                <CardContent>
                  <div className="space-y-2">
                    {antiCheatingLog.map((v, index) => {
                      const label =
                        v.type === "page_departure"
                          ? "Page departure"
                          : v.type === "tab_switch"
                            ? "Page departure"
                            : v.type === "focus_lost"
                              ? "Page departure"
                              : v.type === "paste"
                                ? "External paste blocked"
                                : v.type === "multi_screen"
                                  ? "Multi-screen detected"
                                  : v.type === "multiple_faces"
                                    ? "Multiple faces detected"
                                    : v.type === "face_not_visible"
                                      ? "Candidate face not visible"
                                      : v.type === "looking_away"
                                        ? "Looking away from screen"
                                        : v.type === "prohibited_object"
                                          ? "Prohibited object detected"
                                          : v.type;

                      const eventTime = new Date(v.timestamp);

                      return (
                        <div
                          key={`${v.timestamp}-${v.type}-${index}`}
                          className="rounded-lg border bg-amber-50/60 px-3 py-2.5 dark:bg-amber-950/20"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                                {label}
                              </p>

                              {v.detail && (
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {v.detail}
                                </p>
                              )}
                            </div>

                            <div className="shrink-0 text-right">
                              <p className="text-xs font-medium text-muted-foreground">
                                {eventTime.toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                })}
                              </p>

                              <p className="text-[10px] text-muted-foreground/70">
                                {eventTime.toLocaleDateString(undefined, {
                                  day: "2-digit",
                                  month: "short",
                                  year: "numeric",
                                })}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Code Snippets */}
            {(() => {

              const codeMsgs = summary.data?.messages.filter(
                (m: any) => (m.contentType as string) === "CODE",
              );
              if (!codeMsgs || codeMsgs.length === 0) return null;
              return (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Code2 className="h-4 w-4" />
                      Code Snippets
                      <Badge variant="secondary" className="ml-1 font-normal">
                        {codeMsgs.length}{" "}
                        {codeMsgs.length === 1 ? "snippet" : "snippets"}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {codeMsgs.map((msg: any) => {
                      const data = msg.whiteboardData as Record<
                        string,
                        unknown
                      > | null;
                      const label = (data?.label as string) ?? "Code Snippet";
                      const code = (data?.code as string) ?? "";
                      const language =
                        (data?.language as string) ?? "plaintext";
                      return (
                        <div
                          key={msg.id}
                          className="overflow-hidden rounded-lg border bg-zinc-950"
                        >
                          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
                            <span className="text-xs font-medium text-zinc-200">
                              {label}
                            </span>
                            <div className="flex items-center gap-2">
                              <Badge
                                variant="outline"
                                className="border-zinc-700 text-[10px] font-normal text-zinc-400"
                              >
                                {language}
                              </Badge>
                              <span className="text-[10px] text-zinc-500">
                                {new Date(msg.timestamp).toLocaleTimeString(
                                  undefined,
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                              </span>
                            </div>
                          </div>
                          <CodeBlock
                            code={code}
                            language={language}
                            className="text-sm"
                          />
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              );
            })()}

            {/* Audio recordings remain visible while playback loads. */}
            {(() => {
              const recordings: Array<{ url: string; segmentIndex: number }> =
                summary.data?.audioRecordings?.length
                  ? summary.data.audioRecordings
                  : summary.data?.audioRecordingUrl
                    ? [{ url: summary.data.audioRecordingUrl, segmentIndex: 0 }]
                    : [];
              if (!recordings.length) return null;
              return (
                <Card>
                  <CardHeader><CardTitle className="flex items-center gap-2"><Mic className="h-4 w-4" />Audio Recording</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {recordings.map((rec) => (
                      <audio controls preload="auto" src={rec.url} key={`${rec.segmentIndex}-${rec.url}`} className="w-full" />
                    ))}
                  </CardContent>
                </Card>
              );
            })()}

            {/* Full screen video recording */}
            {summary.data?.screenRecordingUrl && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Monitor className="h-4 w-4" />
                    Screen Recording
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <SeekableVideoPlayer
                    src={summary.data.screenRecordingUrl}
                    fallbackDurationSeconds={summary.data?.totalDurationSeconds}
                  />
                </CardContent>
              </Card>
            )}

            {/* Camera video recording */}
            {summary.data?.cameraRecordingUrl && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Video className="h-4 w-4" />
                    Camera Recording
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <SeekableVideoPlayer
                    src={summary.data.cameraRecordingUrl}
                    fallbackDurationSeconds={summary.data?.totalDurationSeconds}
                  />
                </CardContent>
              </Card>
            )}

            {/* Screenshots */}
            {(() => {
              const screenshots = summary.data?.screenshots as
                | {
                    url: string;
                    path: string;
                    timestamp: string;
                    type: "camera" | "screen";
                  }[]
                | null;
              if (!screenshots || screenshots.length === 0) return null;
              const cameraShots = screenshots.filter(
                (s) => s.type === "camera",
              );
              const screenShots = screenshots.filter(
                (s) => s.type === "screen",
              );
              return (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Camera className="h-4 w-4" />
                      Interview Screenshots
                      <Badge variant="secondary" className="ml-1 font-normal">
                        {screenshots.length}{" "}
                        {screenshots.length === 1 ? "capture" : "captures"}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {cameraShots.length > 0 && (
                      <div>
                        <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                          <Camera className="h-3.5 w-3.5" />
                          Camera
                        </p>
                        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                          {cameraShots.map((shot, i) => (
                            <button
                              key={i}
                              type="button"
                              className="group overflow-hidden rounded-lg border bg-card p-1 text-left transition-shadow hover:shadow-md hover:ring-1 hover:ring-primary/30"
                              onClick={() =>
                                setLightboxImg({
                                  src: shot.url,
                                  alt: `Camera screenshot at ${new Date(shot.timestamp).toLocaleTimeString()}`,
                                })
                              }
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={shot.url}
                                alt={`Camera at ${new Date(shot.timestamp).toLocaleTimeString()}`}
                                className="h-24 w-full rounded object-cover"
                              />
                              <p className="mt-0.5 text-center text-[10px] text-muted-foreground/60">
                                {new Date(shot.timestamp).toLocaleTimeString(
                                  undefined,
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                              </p>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {screenShots.length > 0 && (
                      <div>
                        <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                          <Monitor className="h-3.5 w-3.5" />
                          Screen
                        </p>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                          {screenShots.map((shot, i) => (
                            <button
                              key={i}
                              type="button"
                              className="group overflow-hidden rounded-lg border bg-card p-1 text-left transition-shadow hover:shadow-md hover:ring-1 hover:ring-primary/30"
                              onClick={() =>
                                setLightboxImg({
                                  src: shot.url,
                                  alt: `Screen screenshot at ${new Date(shot.timestamp).toLocaleTimeString()}`,
                                })
                              }
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={shot.url}
                                alt={`Screen at ${new Date(shot.timestamp).toLocaleTimeString()}`}
                                className="h-36 w-full rounded object-cover"
                              />
                              <p className="mt-0.5 text-center text-[10px] text-muted-foreground/60">
                                {new Date(shot.timestamp).toLocaleTimeString(
                                  undefined,
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                              </p>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            {/* Transcript — collapsible (forced open during PDF export) */}
            <Card>
              <CardHeader
                className="cursor-pointer select-none"
                onClick={() => setTranscriptOpen((prev) => !prev)}
              >
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <MessageCircle className="h-4 w-4" />
                    Transcript
                    <Badge variant="secondary" className="ml-1 font-normal">
                      {(summary.data?.messages ?? []).filter(
                        (m: any) =>
                          m.contentType !== "WHITEBOARD" &&
                          (m.contentType as string) !== "CODE",
                      ).length}{" "}
                      messages
                    </Badge>
                  </CardTitle>
                  {!pdfCapture &&
                    (transcriptOpen ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ))}
                </div>
              </CardHeader>
              {(transcriptOpen || pdfCapture) && (
                <CardContent>
                  <div className={pdfCapture ? "space-y-4" : ""}>
                    {!pdfCapture ? (
                      <ScrollArea className="h-[500px]">
                        <div className="space-y-4 pr-4">
                          {(summary.data?.messages ?? []).length === 0 && (
                            <p className="py-8 text-center text-muted-foreground">
                              No messages recorded for this session.
                            </p>
                          )}
                          {(summary.data?.messages ?? [])
                            .filter(
                              (m: any) =>
                                m.contentType !== "WHITEBOARD" &&
                                (m.contentType as string) !== "CODE",
                            )
                            .map((msg: any) => {
                              const isUser = msg.role === "USER";
                              const isChat = msg.transcription === "chat";
                              return (
                                <div
                                  key={msg.id}
                                  className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
                                >
                                  <div
                                    className={`max-w-[75%] rounded-lg px-4 py-2.5 ${
                                      isUser
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-secondary-100 dark:bg-secondary text-secondary-900 dark:text-secondary-foreground"
                                    }`}
                                  >
                                    <div className="mb-1 flex items-center justify-between gap-3">
                                      <span
                                        className={`flex items-center gap-1 text-xs font-semibold ${isUser ? "text-primary-foreground/80" : "text-secondary-700 dark:text-secondary-300"}`}
                                      >
                                        {isUser ? (
                                          isChat ? (
                                            <MessageSquare className="h-3 w-3" />
                                          ) : (
                                            <Mic className="h-3 w-3" />
                                          )
                                        ) : (
                                          <Volume2 className="h-3 w-3" />
                                        )}
                                        {isUser ? "Participant" : "Interviewer"}
                                      </span>
                                      <span
                                        className={`text-[10px] ${isUser ? "text-primary-foreground/60" : "text-secondary-600 dark:text-secondary-400"}`}
                                      >
                                        {new Date(
                                          msg.timestamp,
                                        ).toLocaleTimeString(undefined, {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          second: "2-digit",
                                        })}
                                      </span>
                                    </div>
                                    <p className="text-sm leading-relaxed">
                                      {msg.content}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </ScrollArea>
                    ) : (
                      /* PDF capture mode: no ScrollArea, render all messages flat */
                      <div className="space-y-4">
                        {(summary.data?.messages ?? [])
                          .filter(
                            (m: any) =>
                              m.contentType !== "WHITEBOARD" &&
                              (m.contentType as string) !== "CODE",
                          )
                          .map((msg: any) => {
                            const isUser = msg.role === "USER";
                            const isChat = msg.transcription === "chat";
                            return (
                              <div
                                key={msg.id}
                                className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
                              >
                                <div
                                  className={`max-w-[75%] rounded-lg px-4 py-2.5 ${
                                    isUser
                                      ? "bg-primary text-primary-foreground"
                                      : "bg-secondary-100 dark:bg-secondary text-secondary-900 dark:text-secondary-foreground"
                                  }`}
                                >
                                  <div className="mb-1 flex items-center justify-between gap-3">
                                    <span
                                      className={`flex items-center gap-1 text-xs font-semibold ${isUser ? "text-primary-foreground/80" : "text-secondary-700 dark:text-secondary-300"}`}
                                    >
                                      {isUser ? (
                                        isChat ? (
                                          <MessageSquare className="h-3 w-3" />
                                        ) : (
                                          <Mic className="h-3 w-3" />
                                        )
                                      ) : (
                                        <Volume2 className="h-3 w-3" />
                                      )}
                                      {isUser ? "Participant" : "Interviewer"}
                                    </span>
                                    <span
                                      className={`text-[10px] ${isUser ? "text-primary-foreground/60" : "text-secondary-600 dark:text-secondary-400"}`}
                                    >
                                      {new Date(
                                        msg.timestamp,
                                      ).toLocaleTimeString(undefined, {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                        second: "2-digit",
                                      })}
                                    </span>
                                  </div>
                                  <p className="text-sm leading-relaxed">
                                    {msg.content}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          </div>
        </>
      )}

      {/* End interview confirmation for in-progress sessions */}
      <AlertDialog open={showEndConfirm} onOpenChange={setShowEndConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              End interview and generate report?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This interview is still in progress. Generating the report will
              end the interview — the candidate will no longer be able to
              continue. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmEndAndGenerate}>
              End Interview & Generate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Lightbox overlay for whiteboard drawings */}
      {lightboxImg && (
        <div
          className="!m-0 fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightboxImg(null)}
        >
          <button
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
            onClick={() => setLightboxImg(null)}
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxImg.src}
            alt={lightboxImg.alt}
            className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
