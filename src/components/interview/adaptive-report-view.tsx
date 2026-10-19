"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { AdaptiveReport, CompetencyScore, PathStep } from "@/lib/adaptive/types";
import {
  Activity,
  Award,
  BarChart3,
  Brain,
  CheckCircle2,
  ChevronRight,
  Compass,
  Gauge,
  HelpCircle,
  Layers,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";

interface AdaptiveReportViewProps {
  report: AdaptiveReport;
  className?: string;
}

export function AdaptiveReportView({ report, className }: AdaptiveReportViewProps) {
  const {
    overallTheta,
    percentileEstimate,
    competencyHeatmap,
    adaptivePath,
    questionsServed,
    totalPoolSize,
    earlyCompletionTriggered,
    pathNarrative,
  } = report;

  const getTierColor = (tier: string) => {
    switch (tier) {
      case "HARD":
        return "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/40 dark:text-purple-300";
      case "MEDIUM":
        return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300";
      case "EASY":
      default:
        return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
    }
  };

  const getStatusBadge = (status: CompetencyScore["status"]) => {
    switch (status) {
      case "expert":
        return {
          label: "Expert",
          classes: "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300",
          icon: Sparkles,
        };
      case "proficient":
        return {
          label: "Proficient",
          classes: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
          icon: CheckCircle2,
        };
      case "developing":
        return {
          label: "Developing",
          classes: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
          icon: TrendingUp,
        };
      case "floor":
      default:
        return {
          label: "Foundational Gap",
          classes: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
          icon: TrendingDown,
        };
    }
  };

  return (
    <div className={cn("space-y-6", className)}>
      {/* Top Header Card: Ability & Percentile */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-border/60 bg-gradient-to-br from-card to-card/60 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Overall Calibrated Ability (θ)
            </CardTitle>
            <Brain className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold tracking-tight text-foreground font-mono">
                {overallTheta.toFixed(1)}
              </span>
              <span className="text-xs text-muted-foreground">/ 10.0 scale</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Progress value={overallTheta * 10} className="h-2 flex-1" />
              <span className="text-xs font-medium text-muted-foreground">
                {Math.round(overallTheta * 10)}%
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Dynamically calibrated across all spoken answers
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-gradient-to-br from-card to-card/60 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Estimated Percentile
            </CardTitle>
            <Award className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold tracking-tight text-foreground font-mono">
                {percentileEstimate}
                <span className="text-xl font-bold text-primary">th</span>
              </span>
              <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-[10px]">
                Adaptive Benchmark
              </Badge>
            </div>
            <p className="mt-3 text-xs text-muted-foreground leading-relaxed">
              Outperformed approx. <strong className="text-foreground">{percentileEstimate}%</strong> of benchmarked candidates across equivalent competency difficulty.
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-gradient-to-br from-card to-card/60 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Interview Efficiency
            </CardTitle>
            <Zap className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold tracking-tight text-foreground font-mono">
                {questionsServed}
              </span>
              <span className="text-xs text-muted-foreground">of {totalPoolSize} in pool served</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {earlyCompletionTriggered ? (
                <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30 text-[11px]">
                  ✨ Early Mastery Reached
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[11px]">
                  Calibrated Completion
                </Badge>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Saved ~{Math.max(0, totalPoolSize - questionsServed)} redundant questions via dynamic routing
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recruiter Path Narrative */}
      {pathNarrative && (
        <Card className="border-primary/20 bg-primary/5 shadow-sm">
          <CardContent className="pt-4 pb-4 flex items-start gap-3">
            <Compass className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                Adaptive Assessment Narrative
              </p>
              <p className="text-xs leading-relaxed text-foreground/90">
                {pathNarrative}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Competency Heatmap */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" />
                Competency Calibration Heatmap
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Per-competency ability estimate (θ), questions answered, and status classification
              </p>
            </div>
            <Badge variant="outline" className="text-[11px] font-normal">
              {competencyHeatmap.length} Competencies Evaluated
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {competencyHeatmap.map((item) => {
              const statusCfg = getStatusBadge(item.status);
              const StatusIcon = statusCfg.icon;

              return (
                <div
                  key={item.competencyGroup}
                  className="rounded-xl border border-border/70 bg-card p-3.5 space-y-3 transition-all hover:border-border hover:shadow-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold capitalize text-foreground">
                        {item.competencyGroup.replace(/_/g, " ")}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {item.questionsAnswered} question{item.questionsAnswered !== 1 ? "s" : ""} answered
                      </p>
                    </div>
                    <Badge variant="outline" className={cn("text-[10px] gap-1", statusCfg.classes)}>
                      <StatusIcon className="h-3 w-3" />
                      {statusCfg.label}
                    </Badge>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground text-[11px]">Calibrated θ</span>
                      <span className="font-mono font-bold text-foreground">
                        {item.finalTheta.toFixed(1)} / 10
                      </span>
                    </div>
                    <Progress value={item.finalTheta * 10} className="h-1.5" />
                  </div>

                  <div className="flex items-center justify-between pt-1 border-t border-border/50 text-[11px] text-muted-foreground">
                    <span>Avg Question Score:</span>
                    <span className="font-mono font-medium text-foreground">
                      {item.averageScore.toFixed(1)}/10
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Adaptive Progression Trail */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Adaptive Route & Difficulty Progression
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            The sequence of questions served, how the difficulty adapted, and how the ability estimate (θ) reacted
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {adaptivePath.map((step, idx) => (
              <div
                key={idx}
                className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 transition-all hover:bg-muted/40"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold font-mono">
                  {step.questionNumber}
                </div>

                <div className="flex-1 space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-foreground line-clamp-1">
                      {step.questionText}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn("text-[10px] uppercase font-mono px-1.5 py-0", getTierColor(step.tier))}
                    >
                      {step.tier} (Lv {step.difficultyLevel})
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] capitalize">
                      {step.competency.replace(/_/g, " ")}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs pt-1 text-muted-foreground">
                    {step.aiScore !== null && (
                      <span className="flex items-center gap-1">
                        Score:{" "}
                        <strong className="font-mono text-foreground font-semibold">
                          {step.aiScore.toFixed(1)}/10
                        </strong>
                      </span>
                    )}
                    {step.thetaAfter !== null && (
                      <span className="flex items-center gap-1">
                        θ:{" "}
                        <strong className="font-mono text-primary font-semibold">
                          {step.thetaBefore?.toFixed(1) ?? "—"} → {step.thetaAfter.toFixed(1)}
                        </strong>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
