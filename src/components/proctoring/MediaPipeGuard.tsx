"use client";

import React, { useEffect, useRef, useState } from "react";
import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import { suppressMediaPipeConsoleErrors } from "./suppress-mediapipe-logs";

if (typeof window !== "undefined") {
  suppressMediaPipeConsoleErrors();
}

interface MediaPipeGuardProps {
  onViolation?: (violation: string) => void;
  enabled?: boolean;
}

const VIOLATION_COOLDOWN_MS = 8_000;
const VIOLATION_FRAMES_THRESHOLD = 10;

export default function MediaPipeGuard({
  onViolation,
  enabled = true,
}: MediaPipeGuardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Initializing Face AI...");
  const [warning, setWarning] = useState<string | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const onViolationRef = useRef(onViolation);
  const lastViolationAtRef = useRef<Record<string, number>>({});
  const violationStreakRef = useRef<{ type: string | null; count: number }>({
    type: null,
    count: 0,
  });

  useEffect(() => {
    onViolationRef.current = onViolation;
  }, [onViolation]);

  useEffect(() => {
    suppressMediaPipeConsoleErrors();
    if (!enabled) return;
    let active = true;
    const videoEl = videoRef.current;

    const emitViolation = (type: string, message: string) => {
      if (violationStreakRef.current.type === type) {
        violationStreakRef.current.count += 1;
      } else {
        violationStreakRef.current = { type, count: 1 };
      }

      if (violationStreakRef.current.count < VIOLATION_FRAMES_THRESHOLD) {
        return;
      }

      setWarning(message);
      const now = Date.now();
      const lastAt = lastViolationAtRef.current[type] ?? 0;
      if (now - lastAt >= VIOLATION_COOLDOWN_MS) {
        lastViolationAtRef.current[type] = now;
        onViolationRef.current?.(type);
      }
    };

    const startDetectLoop = () => {
      let lastTime = -1;
      let lastTimestampMs = 0;

      const loop = () => {
        if (!active) return;
        const vid = videoRef.current;
        const landmarker = landmarkerRef.current;

        if (
          vid &&
          landmarker &&
          vid.readyState >= 2 &&
          vid.videoWidth > 0 &&
          !vid.paused &&
          !vid.ended &&
          vid.currentTime !== lastTime
        ) {
          lastTime = vid.currentTime;
          const nowMs = Math.max(Math.floor(performance.now()), lastTimestampMs + 1);
          lastTimestampMs = nowMs;
          try {
            const res = landmarker.detectForVideo(vid, nowMs);
            if (res) {
              if (res.faceLandmarks.length > 1) {
                emitViolation("multiple_faces", "⚠️ Multiple faces detected!");
              } else if (res.faceLandmarks.length === 0) {
                emitViolation("face_not_visible", "⚠️ Candidate missing!");
              } else {
                const nose = res.faceLandmarks[0]?.[1];
                if (
                  nose &&
                  (nose.x < 0.25 || nose.x > 0.75 || nose.y < 0.15 || nose.y > 0.85)
                ) {
                  emitViolation("looking_away", "⚠️ Looking away!");
                } else {
                  violationStreakRef.current = { type: null, count: 0 };
                  setWarning(null);
                }
              }
            }
          } catch {
            // Frame transient error; continue on next animation frame
          }
        }
        if (active) {
          animFrameRef.current = requestAnimationFrame(loop);
        }
      };

      animFrameRef.current = requestAnimationFrame(loop);
    };

    const startCam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" },
        });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          const onReady = () => {
            if (!active) return;
            void videoRef.current?.play().catch(() => {});
            setStatus("Face Tracking Active");
            startDetectLoop();
          };
          if (videoRef.current.readyState >= 1) {
            onReady();
          } else {
            videoRef.current.onloadedmetadata = onReady;
          }
        }
      } catch {
        if (active) setStatus("Webcam error");
      }
    };

    async function loadModel() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm",
        );
        const modelAssetPath =
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

        let landmarker: FaceLandmarker;
        try {
          landmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath,
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            numFaces: 2,
          });
        } catch {
          landmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath,
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            numFaces: 2,
          });
        }

        if (!active) {
          try {
            landmarker.close();
          } catch {
            // ignore
          }
          return;
        }

        landmarkerRef.current = landmarker;
        await startCam();
      } catch {
        if (active) setStatus("MediaPipe failed to load");
      }
    }

    void loadModel();

    return () => {
      active = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = 0;
      }
      if (landmarkerRef.current) {
        try {
          landmarkerRef.current.close();
        } catch {
          // ignore
        }
        landmarkerRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoEl) {
        videoEl.onloadedmetadata = null;
      }
    };
  }, [enabled]);

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 w-48 shadow-lg">
      <video
        ref={videoRef}
        data-proctoring-video="true"
        className="w-full aspect-video bg-black rounded object-cover -scale-x-100 mb-2"
        muted
        playsInline
      />
      <div className="text-xs text-slate-300 flex justify-between items-center">
        <span>{status}</span>
        <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
      </div>
      {warning && (
        <div className="mt-1 text-[10px] bg-red-500/20 text-red-300 p-1 rounded font-bold text-center">
          {warning}
        </div>
      )}
    </div>
  );
}