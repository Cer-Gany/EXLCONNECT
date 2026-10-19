"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { AI_TONES, FOLLOW_UP_DEPTHS, LANGUAGES } from "@/lib/constants";
import { validateAdaptivePool } from "@/lib/adaptive/pool-validation";
import { trpc } from "@/lib/trpc/client";
import {
    Brain,
    Copy,
    Globe,
    LinkIcon as LinkPlusIcon,
    Loader2,
    Lock,
    MessageSquare,
    Mic,
    ShieldCheck,
    Video,
    X
} from "lucide-react";
import { useCallback, useState } from "react";
import { useEditInterview } from "../edit-context";

interface AdaptiveQuestionMetadata {
  difficultyLevel?: number | null;
  skillTag?: string | null;
  competencyGroup?: string | null;
}

interface AdaptiveInterviewSettings {
  adaptiveMode?: boolean;
  adaptiveConfig?: {
    startingDifficulty?: number;
    masteryThreshold?: number;
    minQuestionsPerCompetency?: number;
    maxQuestionsPerCompetency?: number;
  } | null;
  questions?: AdaptiveQuestionMetadata[];
}

interface AdaptiveSuggestion {
  id: string;
  text: string;
  difficultyLevel: number;
  skillTag: string;
  competencyGroup: string;
}

function normalizeInterviewLanguage(language?: string | null): string {
  const normalized = language?.trim().toLowerCase();
  switch (normalized) {
    case "zh":
    case "zh-cn":
    case "zh_hans":
    case "chinese":
    case "chinese (中文)":
    case "中文":
      return "zh";
    case "es":
    case "spanish":
    case "español":
      return "es";
    case "fr":
    case "french":
    case "français":
      return "fr";
    case "en":
    case "english":
    default:
      return "en";
  }
}

export default function SettingsTab() {
  const { interview, interviewId, updateMutation } = useEditInterview();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const publishMutation = trpc.interview.publish.useMutation();

  const [title, setTitle] = useState<string>(interview.title);
  const [description, setDescription] = useState<string>(interview.description ?? "");
  const [objective, setObjective] = useState<string>(interview.objective ?? "");
  const [chatEnabled, setChatEnabled] = useState<boolean>(interview.chatEnabled ?? true);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(interview.voiceEnabled ?? false);
  const [videoEnabled, setVideoEnabled] = useState<boolean>(interview.videoEnabled ?? false);
  const [aiName, setAiName] = useState<string>(interview.aiName);
  const [aiTone, setAiTone] = useState<string>(interview.aiTone);
  const [followUpDepth, setFollowUpDepth] = useState<string>(interview.followUpDepth);
  const [language, setLanguage] = useState<string>(
    normalizeInterviewLanguage(interview.language),
  );
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<string | number>(
    interview.timeLimitMinutes ?? "",
  );
  const [antiCheatingEnabled, setAntiCheatingEnabled] = useState<boolean>(
    interview.antiCheatingEnabled ?? false,
  );
  const [adaptiveMode, setAdaptiveMode] = useState<boolean>(
    (interview as unknown as AdaptiveInterviewSettings).adaptiveMode ?? false,
  );
  const [startingDifficulty, setStartingDifficulty] = useState<number>(
    (interview as unknown as AdaptiveInterviewSettings).adaptiveConfig?.startingDifficulty ?? 5,
  );
  const [masteryThreshold, setMasteryThreshold] = useState<number>(
    (interview as unknown as AdaptiveInterviewSettings).adaptiveConfig?.masteryThreshold ?? 7.5,
  );
  const [minQuestionsPerCompetency, setMinQuestionsPerCompetency] = useState<number>(
    (interview as unknown as AdaptiveInterviewSettings).adaptiveConfig?.minQuestionsPerCompetency ?? 2,
  );
  const [maxQuestionsPerCompetency, setMaxQuestionsPerCompetency] = useState<number>(
    (interview as unknown as AdaptiveInterviewSettings).adaptiveConfig?.maxQuestionsPerCompetency ?? 6,
  );
  const [adaptiveSuggestions, setAdaptiveSuggestions] = useState<AdaptiveSuggestion[] | null>(null);
  const prepareAdaptivePoolMutation = trpc.question.prepareAdaptivePool.useMutation({
    onSuccess: (data) => {
      setAdaptiveSuggestions(data.suggestions);
    },
    onError: (error) => {
      toast({ title: "Could not prepare adaptive pool", description: error.message, variant: "destructive" });
    },
  });
  const applyAdaptivePoolMutation = trpc.question.applyAdaptivePool.useMutation({
    onSuccess: async () => {
      await utils.interview.getById.invalidate({ id: interviewId });
      setAdaptiveSuggestions(null);
      toast({ title: "Adaptive metadata applied", description: "Your existing questions are ready for adaptive routing." });
    },
    onError: (error) => {
      toast({ title: "Could not apply adaptive metadata", description: error.message, variant: "destructive" });
    },
  });
  const adaptiveInterview = interview as unknown as AdaptiveInterviewSettings;
  const adaptivePoolValidation = validateAdaptivePool(
    (adaptiveInterview.questions ?? []).map((question) => ({
      difficultyLevel: question.difficultyLevel ?? 5,
      skillTag: question.skillTag ?? "",
      competencyGroup: question.competencyGroup ?? "",
    })),
  );

  const requireInvite = interview.requireInvite ?? true;
  const hasShareableLink = !requireInvite;
  const shareableUrl =
    hasShareableLink &&
    interview.publicSlug &&
    interview.isActive &&
    typeof window !== "undefined"
      ? `${window.location.origin}/i/${interview.publicSlug}`
      : null;

  const isLinkLoading = updateMutation.isLoading || publishMutation.isLoading;

  const handleCreateShareableLink = useCallback(() => {
    publishMutation.mutate(
      { id: interviewId },
      {
        onSuccess: () => {
          updateMutation.mutate(
            { id: interviewId, requireInvite: false },
            {
              onSuccess: () => {
                utils.interview.getById.invalidate({ id: interviewId });
                toast({ title: "Shareable link created" });
              },
            },
          );
        },
      },
    );
  }, [interviewId, publishMutation, updateMutation, utils, toast]);

  const handleRevokeShareableLink = useCallback(() => {
    updateMutation.mutate(
      { id: interviewId, requireInvite: true, isActive: false },
      {
        onSuccess: () => {
          utils.interview.getById.invalidate({ id: interviewId });
          toast({ title: "Shareable link revoked" });
        },
      },
    );
  }, [interviewId, updateMutation, utils, toast]);

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* Shareable Link */}
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Shareable Link</CardTitle>
        </CardHeader>
        <CardContent>
          {hasShareableLink ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary-100 text-secondary-600 dark:bg-secondary-900/30 dark:text-secondary-400">
                  <Globe className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Open access enabled</p>
                  <p className="text-xs text-muted-foreground">
                    Anyone with this link can start the interview
                  </p>
                </div>
              </div>
              {shareableUrl && (
                <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
                  <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {shareableUrl}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2"
                    onClick={() => {
                      navigator.clipboard.writeText(shareableUrl);
                      toast({ title: "Link copied!" });
                    }}
                  >
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy
                  </Button>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={handleRevokeShareableLink}
                disabled={isLinkLoading}
              >
                {isLinkLoading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="mr-2 h-3.5 w-3.5" />
                )}
                Revoke shareable link
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Lock className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium">Invite only</p>
                  <p className="text-xs text-muted-foreground">
                    Only sessions added from the Sessions tab can access this
                    interview via their unique invite links.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCreateShareableLink}
                disabled={isLinkLoading}
              >
                {isLinkLoading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LinkPlusIcon className="mr-2 h-3.5 w-3.5" />
                )}
                Create shareable link
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Objective</Label>
            <Textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Duration (minutes)</Label>
            <Input
              type="number"
              value={timeLimitMinutes}
              onChange={(e) => setTimeLimitMinutes(e.target.value)}
              placeholder="No limit"
            />
          </div>
          <div className="space-y-2">
            <Label>Communication Channels</Label>
            <p className="text-xs text-muted-foreground">
              Choose how participants interact during the interview
            </p>
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <Label>Chat</Label>
                    <p className="text-xs text-muted-foreground">Text messaging</p>
                  </div>
                </div>
                <Switch
                  checked={chatEnabled}
                  onCheckedChange={(v) => {
                    if (!v && !voiceEnabled) return;
                    setChatEnabled(v);
                  }}
                />
              </div>
              <div className="border-t" />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Mic className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <Label>Voice</Label>
                    <p className="text-xs text-muted-foreground">Speech conversation</p>
                  </div>
                </div>
                <Switch
                  checked={voiceEnabled}
                  onCheckedChange={(v) => {
                    if (!v && !chatEnabled) return;
                    setVoiceEnabled(v);
                    if (!v) setVideoEnabled(false);
                  }}
                />
              </div>
              <div className="border-t" />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Video className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <Label>Video</Label>
                    <p className="text-xs text-muted-foreground">Camera &amp; screen recording</p>
                  </div>
                </div>
                <Switch
                  checked={videoEnabled}
                  disabled={!voiceEnabled}
                  onCheckedChange={setVideoEnabled}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>AI Name</Label>
            <Input value={aiName} onChange={(e) => setAiName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Tone</Label>
            <Select value={aiTone} onValueChange={setAiTone}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_TONES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Follow-up Depth</Label>
            <Select value={followUpDepth} onValueChange={setFollowUpDepth}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FOLLOW_UP_DEPTHS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label} ({d.description})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Language</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Anti-Cheating Mode</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <div>
                  <Label>Enable Anti-Cheating</Label>
                  <p className="text-xs text-muted-foreground">
                    Requires camera, mic & screen sharing. Monitors tab switches, blocks external paste, and detects multiple screens
                  </p>
                </div>
              </div>
              <Switch
                checked={antiCheatingEnabled}
                onCheckedChange={setAntiCheatingEnabled}
              />
            </div>
            {antiCheatingEnabled && (
              <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                <p className="font-medium">When enabled, interviewees will experience:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  <li>Camera, microphone, and screen sharing will be mandatory (cannot be skipped)</li>
                  <li>Tab switching and window focus loss will be tracked and flagged</li>
                  <li>Pasting content from outside the interview page will be blocked</li>
                  <li>Multiple monitor setups will be detected and warned against</li>
                </ul>
                <p className="mt-1.5 text-amber-700 dark:text-amber-300">
                  Candidates will be informed of these restrictions before starting.
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            Adaptive Testing Engine (GRE / GMAT Style)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-semibold">Enable Adaptive Mode</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Dynamically adjust question difficulty and sequence in real-time based on candidate performance.
                </p>
              </div>
              <Switch
                checked={adaptiveMode}
                onCheckedChange={setAdaptiveMode}
              />
            </div>

            {adaptiveMode && (
              <div className="mt-4 space-y-4 border-t pt-4">
                <div className={`rounded-md border p-3 text-xs ${
                  adaptivePoolValidation.valid
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-destructive/40 bg-destructive/5"
                }`}>
                  <p className="font-medium">
                    Adaptive pool: {adaptivePoolValidation.questionCount} questions across{" "}
                    {adaptivePoolValidation.competencies.length} competencies
                  </p>
                  {adaptivePoolValidation.issues.length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-destructive">
                      {adaptivePoolValidation.issues.map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                  )}
                  {adaptivePoolValidation.warnings.length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-amber-700 dark:text-amber-300">
                      {adaptivePoolValidation.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  )}
                  {adaptivePoolValidation.valid && adaptivePoolValidation.warnings.length === 0 && (
                    <p className="mt-1 text-emerald-700 dark:text-emerald-300">
                      Coverage is ready for adaptive routing.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 p-3">
                  <div>
                    <p className="font-medium">Prepare an existing assessment</p>
                    <p className="text-muted-foreground">
                      Gemini will suggest difficulty, skills, and competency groups for review before saving.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={prepareAdaptivePoolMutation.isLoading}
                    onClick={() => prepareAdaptivePoolMutation.mutate({ interviewId })}
                  >
                    {prepareAdaptivePoolMutation.isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Prepare with Gemini
                  </Button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs">Starting Difficulty (1–10)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={startingDifficulty}
                      onChange={(e) => setStartingDifficulty(Number(e.target.value) || 5)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Initial difficulty tier served to the candidate (default: 5 — Medium).
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs">Mastery Threshold θ (1–10)</Label>
                    <Input
                      type="number"
                      step={0.5}
                      min={5}
                      max={9.5}
                      value={masteryThreshold}
                      onChange={(e) => setMasteryThreshold(Number(e.target.value) || 7.5)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Ability score (θ) at which a competency is marked mastered (default: 7.5).
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs">Min Questions per Competency</Label>
                    <Input
                      type="number"
                      min={1}
                      max={5}
                      value={minQuestionsPerCompetency}
                      onChange={(e) => setMinQuestionsPerCompetency(Number(e.target.value) || 2)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Minimum questions to evaluate before routing to next competency (default: 2).
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs">Max Questions per Competency</Label>
                    <Input
                      type="number"
                      min={3}
                      max={10}
                      value={maxQuestionsPerCompetency}
                      onChange={(e) => setMaxQuestionsPerCompetency(Number(e.target.value) || 6)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Safety cap on questions in any single competency group (default: 6).
                    </p>
                  </div>
                </div>

                <div className="rounded-md bg-primary/10 p-3 text-xs text-foreground/90 space-y-1">
                  <p className="font-medium text-primary">How Adaptive Testing Works in EXLConnect:</p>
                  <ul className="list-inside list-disc text-muted-foreground space-y-0.5">
                    <li>Responses are scored (1–10) in the background during natural transition pauses.</li>
                    <li>Ability estimate (θ) updates via Exponential Moving Average (EMA).</li>
                    <li>High scores branch to harder questions; foundational struggles pivot to alternate skills.</li>
                    <li>Recruiters receive a calibrated ability score, percentile benchmark, and competency heatmap.</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={adaptiveSuggestions !== null} onOpenChange={(open) => !open && setAdaptiveSuggestions(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Review adaptive metadata</DialogTitle>
            <DialogDescription>
              Confirm these suggestions before they are written to the assessment questions.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {adaptiveSuggestions?.map((suggestion, index) => (
              <div key={suggestion.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">Q{index + 1}: {suggestion.text}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Difficulty {suggestion.difficultyLevel}/10 · {suggestion.skillTag} · {suggestion.competencyGroup}
                </p>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAdaptiveSuggestions(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={applyAdaptivePoolMutation.isLoading || !adaptiveSuggestions}
              onClick={() => adaptiveSuggestions && applyAdaptivePoolMutation.mutate({
                interviewId,
                suggestions: adaptiveSuggestions.map(({ id, difficultyLevel, skillTag, competencyGroup }) => ({
                  id,
                  difficultyLevel,
                  skillTag,
                  competencyGroup,
                })),
              })}
            >
              {applyAdaptivePoolMutation.isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Apply metadata
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex items-end">
        <Button
          onClick={() =>
            updateMutation.mutate({
              id: interviewId,
              title,
              description,
              objective,
              chatEnabled,
              voiceEnabled,
              videoEnabled,
              aiName,
              aiTone,
              followUpDepth,
              language,
              timeLimitMinutes: timeLimitMinutes
                ? Number(timeLimitMinutes)
                : null,
              antiCheatingEnabled,
              adaptiveMode,
              adaptiveConfig: {
                startingDifficulty,
                masteryThreshold,
                minQuestionsPerCompetency,
                maxQuestionsPerCompetency,
                learningRate: 0.3,
                floorThreshold: 2.5,
              },
            })
          }
          disabled={updateMutation.isLoading || (adaptiveMode && !adaptivePoolValidation.valid)}
        >
          {updateMutation.isLoading && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          Save Settings
        </Button>
      </div>
    </div>
  );
}
