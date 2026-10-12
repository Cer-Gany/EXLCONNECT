"use client";

import React, { useEffect, useRef, useState } from "react";
import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";

interface YoloGuardProps {
  onObjectDetected?: (objectName: string) => void;
  enabled?: boolean;
}

const PROHIBITED_LABELS = new Set([
  "cell phone",
  "book",
]);

const DETECTION_COOLDOWN_MS = 8_000;

export default function YoloObjectGuard({
  onObjectDetected,
  enabled = true,
}: YoloGuardProps) {
  const [objectStatus, setObjectStatus] = useState("Initializing Object AI...");
  const [detectedObj, setDetectedObj] = useState<string | null>(null);
  const detectorRef = useRef<ObjectDetector | null>(null);
  const onObjectDetectedRef = useRef(onObjectDetected);
  const lastReportedAtRef = useRef<Record<string, number>>({});

  useEffect(() => {
    onObjectDetectedRef.current = onObjectDetected;
  }, [onObjectDetected]);

  useEffect(() => {
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
        try {
          detector = await ObjectDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath, delegate: "GPU" },
            scoreThreshold: 0.45,
            runningMode: "VIDEO",
          });
        } catch {
          detector = await ObjectDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath, delegate: "CPU" },
            scoreThreshold: 0.45,
            runningMode: "VIDEO",
          });
        }

        if (!active) {
          detector.close();
          return;
        }

        detectorRef.current = detector;
        setObjectStatus("Scanning for phones/books...");

        intervalId = setInterval(() => {
          if (!active || !detectorRef.current) return;
          const videoEl =
            (document.querySelector(
              'video[data-proctoring-video="true"]',
            ) as HTMLVideoElement | null) ??
            (document.querySelector("video") as HTMLVideoElement | null);

          if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) {
            return;
          }

          try {
            const nowMs = Math.max(Math.floor(performance.now()), lastTimestampMs + 1);
            lastTimestampMs = nowMs;
            const result = detectorRef.current.detectForVideo(
              videoEl,
              nowMs,
            );
            const prohibited = result.detections
              .flatMap((d) => d.categories)
              .find((c) =>
                PROHIBITED_LABELS.has(c.categoryName.toLowerCase()),
              );

            if (prohibited) {
              const label = prohibited.categoryName;
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
        }, 1500);
      } catch {
        if (active) {
          setObjectStatus("Object AI unavailable");
        }
      }
    }

    void initObjectDetector();

    return () => {
      active = false;
      if (intervalId) clearInterval(intervalId);
      if (detectorRef.current) {
        try {
          detectorRef.current.close();
        } catch {
          // ignore
        }
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