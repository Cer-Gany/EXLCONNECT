"use client";

import React, { useEffect, useRef, useState } from "react";
import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import { suppressMediaPipeConsoleErrors } from "./suppress-mediapipe-logs";

if (typeof window !== "undefined") {
  suppressMediaPipeConsoleErrors();
}

interface YoloGuardProps {
  onObjectDetected?: (objectName: string) => void;
  enabled?: boolean;
}

// ── Prohibited object labels (EfficientDet COCO classes) ─────────────────────
const PROHIBITED_LABELS = new Set([
  // Communication / AI devices
  "cell phone",
  "laptop",
  "tablet",
  "remote",
  // Audio-assistance indicators
  "headphones",
  // Reference material
  "book",
]);

// Confidence threshold
// 0.40 gives good real-world sensitivity without too many false positives.
const SCORE_THRESHOLD = 0.40;

// How long after a violation fires before the same label can fire again
const DETECTION_COOLDOWN_MS = 8_000;

// Run object detection every N milliseconds.
// EfficientDet Lite-0 takes ~10–20 ms on GPU, so 750 ms is comfortably safe.
const DETECTION_INTERVAL_MS = 750;

export default function YoloObjectGuard({
  onObjectDetected,
  enabled = true,
}: YoloGuardProps) {
  const [objectStatus, setObjectStatus] = useState("Initializing Object AI...");
  const [detectedObj, setDetectedObj]   = useState<string | null>(null);
  const detectorRef        = useRef<ObjectDetector | null>(null);
  const onObjectDetectedRef = useRef(onObjectDetected);
  const lastReportedAtRef  = useRef<Record<string, number>>({});

  useEffect(() => { onObjectDetectedRef.current = onObjectDetected; }, [onObjectDetected]);

  useEffect(() => {
    suppressMediaPipeConsoleErrors();
    if (!enabled) return;
    let active = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let lastTimestampMs = 0;

    async function initObjectDetector() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm",
        );
        const modelAssetPath =
          "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

        let detector: ObjectDetector;
        const baseOpts = {
          baseOptions: { modelAssetPath, delegate: "GPU" as const },
          scoreThreshold: SCORE_THRESHOLD,
          runningMode: "VIDEO" as const,
          maxResults: 6,
        };

        try {
          detector = await ObjectDetector.createFromOptions(vision, baseOpts);
        } catch {
          detector = await ObjectDetector.createFromOptions(vision, {
            ...baseOpts,
            baseOptions: { modelAssetPath, delegate: "CPU" as const },
          });
        }

        if (!active) { try { detector.close(); } catch { /**/ } return; }

        detectorRef.current = detector;
        console.log("[YoloObjectGuard] ✅ Model ready");
        setObjectStatus("Scanning for prohibited items...");

        intervalId = setInterval(() => {
          if (!active || !detectorRef.current) return;

          const videoEl =
            (document.querySelector('video[data-proctoring-video="true"]') as HTMLVideoElement | null) ??
            (document.querySelector("video") as HTMLVideoElement | null);

          if (
            !videoEl ||
            videoEl.readyState < 2 ||
            videoEl.videoWidth === 0 ||
            videoEl.paused ||
            videoEl.ended
          ) return;

          try {
            const nowMs = Math.max(Math.floor(performance.now()), lastTimestampMs + 1);
            lastTimestampMs = nowMs;
            const result = detectorRef.current.detectForVideo(videoEl, nowMs);

            // Log ALL detections in dev so you can see what the model sees
            if (process.env.NODE_ENV === "development" && result.detections.length > 0) {
              const all = result.detections.flatMap((d) =>
                d.categories.map((c) => `${c.categoryName}(${((c.score ?? 0) * 100).toFixed(0)}%)`),
              );
              console.log("[YoloObjectGuard] detected:", all.join(", "));
            }

            // Collect all prohibited detections this frame
            const prohibited = result.detections
              .flatMap((d) => d.categories)
              .filter((c) => PROHIBITED_LABELS.has(c.categoryName.toLowerCase()));

            if (prohibited.length > 0) {
              // Report the highest-confidence prohibited object first
              const top = prohibited.reduce((a, b) =>
                (a.score ?? 0) >= (b.score ?? 0) ? a : b,
              );
              const label = top.categoryName;
              setDetectedObj(label);

              const now = Date.now();
              const lastAt = lastReportedAtRef.current[label] ?? 0;
              if (now - lastAt >= DETECTION_COOLDOWN_MS) {
                lastReportedAtRef.current[label] = now;
                onObjectDetectedRef.current?.(label);
              }
            } else {
              setDetectedObj(null);
            }
          } catch {
            // Ignore transient frame errors
          }
        }, DETECTION_INTERVAL_MS);
      } catch {
        if (active) setObjectStatus("Object AI unavailable");
      }
    }

    void initObjectDetector();

    return () => {
      active = false;
      if (intervalId) clearInterval(intervalId);
      if (detectorRef.current) {
        try { detectorRef.current.close(); } catch { /**/ }
        detectorRef.current = null;
      }
    };
  }, [enabled]);

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 w-48 shadow-lg mt-2">
      <div className="text-xs text-slate-300 flex justify-between items-center mb-1">
        <span>Object Detection</span>
        <span className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
      </div>
      <div className="text-[11px] text-slate-400">{objectStatus}</div>
      {detectedObj && (
        <div className="mt-1 text-[10px] bg-red-500/20 text-red-300 p-1 rounded font-bold text-center">
          ⚠️ Prohibited: {detectedObj}
        </div>
      )}
    </div>
  );
}