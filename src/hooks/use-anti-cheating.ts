"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Violation types ────────────────────────────────────────────────────────────

export interface AntiCheatingViolation {
  type:
    | "page_departure"
    | "paste"
    | "multi_screen"
    | "multiple_faces"
    | "face_not_visible"
    | "looking_away"
    | "prohibited_object"
    | "suspicious_audio"
    | "loud_sound"
    | "gaze_off_screen";
  timestamp: number;
  detail?: string;
}

// ── Risk scoring ───────────────────────────────────────────────────────────────

/** Points added per violation event */
const VIOLATION_WEIGHTS: Record<AntiCheatingViolation["type"], number> = {
  page_departure:    10,
  paste:             15,
  multi_screen:       8,
  looking_away:       4,
  gaze_off_screen:    6,
  face_not_visible:  12,
  multiple_faces:    25,
  prohibited_object: 20,
  suspicious_audio:  15,
  loud_sound:         5,
};

/** Risk level thresholds (inclusive lower bound) */
export const RISK_THRESHOLDS = {
  GREEN:  { min: 0,  max: 30 },
  YELLOW: { min: 31, max: 60 },
  ORANGE: { min: 61, max: 90 },
  RED:    { min: 91, max: Infinity },
} as const;

export type RiskLevel = "GREEN" | "YELLOW" | "ORANGE" | "RED";

export function getRiskLevel(score: number): RiskLevel {
  if (score <= RISK_THRESHOLDS.GREEN.max)  return "GREEN";
  if (score <= RISK_THRESHOLDS.YELLOW.max) return "YELLOW";
  if (score <= RISK_THRESHOLDS.ORANGE.max) return "ORANGE";
  return "RED";
}

// ── Hook interface ─────────────────────────────────────────────────────────────

interface UseAntiCheatingOptions {
  enabled: boolean;
  onViolation?: (violation: AntiCheatingViolation) => void;
  /** Called whenever the risk level changes (GREEN → YELLOW, etc.) */
  onRiskLevelChange?: (level: RiskLevel, score: number) => void;
}

interface UseAntiCheatingResult {
  violations: AntiCheatingViolation[];
  departureCount: number;
  multiScreenDetected: boolean;
  riskScore: number;
  riskLevel: RiskLevel;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useAntiCheating({
  enabled,
  onViolation,
  onRiskLevelChange,
}: UseAntiCheatingOptions): UseAntiCheatingResult {
  const [violations, setViolations]             = useState<AntiCheatingViolation[]>([]);
  const [departureCount, setDepartureCount]     = useState(0);
  const [multiScreenDetected, setMultiScreenDetected] = useState(false);
  const [riskScore, setRiskScore]               = useState(0);
  const [riskLevel, setRiskLevel]               = useState<RiskLevel>("GREEN");

  const onViolationRef        = useRef(onViolation);
  const onRiskLevelChangeRef  = useRef(onRiskLevelChange);
  const prevRiskLevelRef      = useRef<RiskLevel>("GREEN");

  useEffect(() => { onViolationRef.current = onViolation; }, [onViolation]);
  useEffect(() => { onRiskLevelChangeRef.current = onRiskLevelChange; }, [onRiskLevelChange]);

  // ── Core: add violation + update risk score ──────────────────────────────────
  const addViolation = useCallback((violation: AntiCheatingViolation) => {
    setViolations((prev) => [...prev, violation]);
    onViolationRef.current?.(violation);

    const points = VIOLATION_WEIGHTS[violation.type] ?? 5;
    // Compute next score synchronously so we can also update level atomically
    // (avoids a double-render from two separate setState calls).
    setRiskScore((prev) => {
      const next = prev + points;
      const nextLevel = getRiskLevel(next);
      if (nextLevel !== prevRiskLevelRef.current) {
        prevRiskLevelRef.current = nextLevel;
        // Schedule outside the updater so we don't set state inside a setter
        setTimeout(() => {
          setRiskLevel(nextLevel);
          onRiskLevelChangeRef.current?.(nextLevel, next);
        }, 0);
      }
      return next;
    });
  }, []);

  // ── Tab / window departure ───────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    let blurTimer: ReturnType<typeof setTimeout> | null = null;

    const recordDeparture = () => {
      setDepartureCount((prev) => prev + 1);
      addViolation({ type: "page_departure", timestamp: Date.now() });
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
        recordDeparture();
      }
    };

    const handleBlur = () => {
      blurTimer = setTimeout(() => {
        blurTimer = null;
        recordDeparture();
      }, 200);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);

    return () => {
      if (blurTimer) clearTimeout(blurTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleBlur);
    };
  }, [enabled, addViolation]);

  // ── Paste / copy interception ────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    const internalCopies = new Set<string>();
    // Cap the set size to prevent memory growth during long sessions
    const trackText = (text: string | undefined | null) => {
      const trimmed = text?.trim();
      if (!trimmed) return;
      if (internalCopies.size > 500) {
        // Drop the oldest entry (first item in insertion order)
        const first = internalCopies.values().next().value;
        if (first !== undefined) internalCopies.delete(first);
      }
      internalCopies.add(trimmed);
    };

    const getSelectionText = (): string => {
      const sel = window.getSelection()?.toString()?.trim();
      if (sel) return sel;
      const el = document.activeElement;
      if (
        (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) &&
        el.selectionStart != null &&
        el.selectionEnd != null
      ) {
        return el.value.substring(el.selectionStart, el.selectionEnd).trim();
      }
      return "";
    };

    const handleCopy = (e: ClipboardEvent) => {
      trackText(getSelectionText());
      trackText(e.clipboardData?.getData("text/plain"));
    };

    const handlePaste = (e: ClipboardEvent) => {
      const pastedText = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      if (!pastedText || internalCopies.has(pastedText)) return;
      e.preventDefault();
      e.stopPropagation();
      addViolation({ type: "paste", timestamp: Date.now(), detail: "External content pasted" });
    };

    // Intercept DataTransfer.setData (Monaco editor etc.)
    const origSetData = DataTransfer.prototype.setData;
    DataTransfer.prototype.setData = function (format: string, data: string) {
      if (format === "text/plain" || format === "text") trackText(data);
      return origSetData.call(this, format, data);
    };

    // Intercept Clipboard API writeText
    const origWriteText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (origWriteText) {
      navigator.clipboard.writeText = (text: string) => {
        trackText(text);
        return origWriteText(text);
      };
    }

    document.addEventListener("copy",  handleCopy,  true);
    document.addEventListener("cut",   handleCopy,  true);
    document.addEventListener("paste", handlePaste, true);

    return () => {
      DataTransfer.prototype.setData = origSetData;
      if (origWriteText) navigator.clipboard.writeText = origWriteText;
      document.removeEventListener("copy",  handleCopy,  true);
      document.removeEventListener("cut",   handleCopy,  true);
      document.removeEventListener("paste", handlePaste, true);
    };
  }, [enabled, addViolation]);

  // ── Developer tools / context menu blocking ──────────────────────────────────
  // Only active in production — in development you need DevTools to debug.
  useEffect(() => {
    if (!enabled) return;
    if (process.env.NODE_ENV === "development") return;

    const blockContextMenu = (e: MouseEvent) => e.preventDefault();
    const blockDevTools = (e: KeyboardEvent) => {
      const isDevTools =
        e.key === "F12" ||
        (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J" || e.key === "C")) ||
        (e.ctrlKey && e.key === "U"); // view source
      if (isDevTools) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    document.addEventListener("contextmenu", blockContextMenu);
    document.addEventListener("keydown", blockDevTools, true);

    return () => {
      document.removeEventListener("contextmenu", blockContextMenu);
      document.removeEventListener("keydown", blockDevTools, true);
    };
  }, [enabled]);

  // ── Multi-screen detection ───────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    const checkScreens = () => {
      if (typeof window === "undefined") return;
      const screen = window.screen as Screen & { availLeft?: number };
      const hasMultiple =
        screen.availWidth > screen.width ||
        (screen.availLeft !== undefined && screen.availLeft !== 0);

      if (hasMultiple && !multiScreenDetected) {
        setMultiScreenDetected(true);
        addViolation({
          type: "multi_screen",
          timestamp: Date.now(),
          detail: `Multiple screens detected (${window.screen.availWidth}x${window.screen.availHeight})`,
        });
      }
    };

    const screenDetails = (
      window as unknown as { getScreenDetails?: () => Promise<{ screens: unknown[] }> }
    ).getScreenDetails;

    if (screenDetails) {
      screenDetails()
        .then((details) => {
          if (details.screens.length > 1) {
            setMultiScreenDetected(true);
            addViolation({
              type: "multi_screen",
              timestamp: Date.now(),
              detail: `${details.screens.length} screens detected via Screen API`,
            });
          }
        })
        .catch(() => checkScreens());
    } else {
      checkScreens();
    }

    const interval = setInterval(checkScreens, 10_000);
    return () => clearInterval(interval);
  }, [enabled, multiScreenDetected, addViolation]);

  return { violations, departureCount, multiScreenDetected, riskScore, riskLevel };
}
