"use client";

import React, { useEffect, useRef, useState } from "react";
import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import { suppressMediaPipeConsoleErrors } from "./suppress-mediapipe-logs";

if (typeof window !== "undefined") {
  suppressMediaPipeConsoleErrors();
}

// ── MediaPipe landmark indices ────────────────────────────────────────────────
// Iris centres (FaceLandmarker with iris refinement enabled)
const LEFT_IRIS_CENTER  = 468;
const RIGHT_IRIS_CENTER = 473;

// Eye-corner landmarks used to compute pupil offsets
const LEFT_EYE_OUTER   = 33;
const LEFT_EYE_INNER   = 133;
const RIGHT_EYE_INNER  = 362;
const RIGHT_EYE_OUTER  = 263;

// Eyelid landmarks for Eye Aspect Ratio (blink detection)
const LEFT_EYE_TOP     = 159;
const LEFT_EYE_BOTTOM  = 145;
const RIGHT_EYE_TOP    = 386;
const RIGHT_EYE_BOTTOM = 374;

// ── Tuning ────────────────────────────────────────────────────────────────────
const VIOLATION_COOLDOWN_MS      = 8_000;
const VIOLATION_FRAMES_THRESHOLD = 10;   // consecutive frames before flagging
const RAF_SKIP_FRAMES            = 5;    // run inference every Nth rAF → ~10 FPS

// Gaze: fraction from the iris centre to eye corner that counts as "off screen"
// 0 = perfectly centered, 1 = fully at the edge
const GAZE_H_THRESHOLD = 0.55; // horizontal: flag if pupil > 55% toward outer corner
const GAZE_V_THRESHOLD = 0.60; // vertical: flag if pupil > 60% toward lid edge

// Blink / liveness: flag if no blink detected within this many ms
const LIVENESS_BLINK_WINDOW_MS = 55_000;
const EAR_BLINK_THRESHOLD      = 0.20;  // Eye Aspect Ratio below this = blink

// ── Prop types ────────────────────────────────────────────────────────────────
interface MediaPipeGuardProps {
  onViolation?: (violation: string) => void;
  enabled?: boolean;
  /** Expose the camera stream so the audio guard can reuse it */
  onStreamReady?: (stream: MediaStream) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
type Point = { x: number; y: number; z: number };

function eyeAspectRatio(top: Point, bottom: Point, inner: Point, outer: Point) {
  const vertical   = Math.abs(top.y - bottom.y);
  const horizontal = Math.abs(inner.x - outer.x) || 0.001;
  return vertical / horizontal;
}

function clamp(val: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, val));
}

/** Returns a normalised pupil offset [-1, 1] where 0 = centred in eye.
 *  Positive = looking outward / upward.
 */
function gazeOffset(
  iris: Point,
  innerCorner: Point,
  outerCorner: Point,
  topLid: Point,
  bottomLid: Point,
) {
  const eyeWidth  = Math.abs(innerCorner.x - outerCorner.x) || 0.001;
  const eyeHeight = Math.abs(topLid.y - bottomLid.y) || 0.001;
  const midX = (innerCorner.x + outerCorner.x) / 2;
  const midY = (topLid.y + bottomLid.y) / 2;
  const offsetX = clamp((iris.x - midX) / (eyeWidth  / 2), -1, 1);
  const offsetY = clamp((iris.y - midY) / (eyeHeight / 2), -1, 1);
  return { offsetX, offsetY };
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function MediaPipeGuard({
  onViolation,
  enabled = true,
  onStreamReady,
}: MediaPipeGuardProps) {
  const videoRef      = useRef<HTMLVideoElement>(null);
  const [status, setStatus]   = useState("Initializing Face AI...");
  const [warning, setWarning] = useState<string | null>(null);

  const landmarkerRef         = useRef<FaceLandmarker | null>(null);
  const streamRef             = useRef<MediaStream | null>(null);
  const animFrameRef          = useRef<number>(0);
  const onViolationRef        = useRef(onViolation);
  const onStreamReadyRef      = useRef(onStreamReady);
  const lastViolationAtRef    = useRef<Record<string, number>>({});
  const violationStreakRef     = useRef<{ type: string | null; count: number }>({ type: null, count: 0 });
  const lastBlinkAtRef        = useRef<number>(Date.now());
  const frameCounterRef       = useRef(0);

  useEffect(() => { onViolationRef.current = onViolation; },    [onViolation]);
  useEffect(() => { onStreamReadyRef.current = onStreamReady; }, [onStreamReady]);

  useEffect(() => {
    suppressMediaPipeConsoleErrors();
    if (!enabled) return;
    let active = true;

    // ── Violation emitter with streak de-bounce ──────────────────────────────
    const emitViolation = (type: string, message: string) => {
      if (violationStreakRef.current.type === type) {
        violationStreakRef.current.count += 1;
      } else {
        violationStreakRef.current = { type, count: 1 };
      }
      if (violationStreakRef.current.count < VIOLATION_FRAMES_THRESHOLD) return;

      setWarning(message);
      const now = Date.now();
      const lastAt = lastViolationAtRef.current[type] ?? 0;
      if (now - lastAt >= VIOLATION_COOLDOWN_MS) {
        lastViolationAtRef.current[type] = now;
        onViolationRef.current?.(type);
      }
    };

    const clearStreak = () => {
      violationStreakRef.current = { type: null, count: 0 };
      setWarning(null);
    };

    // ── Main inference loop ──────────────────────────────────────────────────
    let lastTime       = -1;
    let lastTimestampMs = 0;

    const loop = () => {
      if (!active) return;

      frameCounterRef.current++;
      if (frameCounterRef.current % RAF_SKIP_FRAMES !== 0) {
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      const vid        = videoRef.current;
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

          if (!res) {
            animFrameRef.current = requestAnimationFrame(loop);
            return;
          }

          // ── 1. Multiple faces ────────────────────────────────────────────
          if (res.faceLandmarks.length > 1) {
            emitViolation("multiple_faces", "⚠️ Multiple faces detected!");
            animFrameRef.current = requestAnimationFrame(loop);
            return;
          }

          // ── 2. No face ───────────────────────────────────────────────────
          if (res.faceLandmarks.length === 0) {
            emitViolation("face_not_visible", "⚠️ Candidate missing!");
            animFrameRef.current = requestAnimationFrame(loop);
            return;
          }

          const lm = res.faceLandmarks[0]!;

          // ── 3. Blink / liveness check ────────────────────────────────────
          const leftTop    = lm[LEFT_EYE_TOP];
          const leftBot    = lm[LEFT_EYE_BOTTOM];
          const leftInner  = lm[LEFT_EYE_INNER];
          const leftOuter  = lm[LEFT_EYE_OUTER];
          const rightTop   = lm[RIGHT_EYE_TOP];
          const rightBot   = lm[RIGHT_EYE_BOTTOM];
          const rightInner = lm[RIGHT_EYE_INNER];
          const rightOuter = lm[RIGHT_EYE_OUTER];

          if (leftTop && leftBot && leftInner && leftOuter && rightTop && rightBot && rightInner && rightOuter) {
            const leftEAR  = eyeAspectRatio(leftTop,  leftBot,  leftInner,  leftOuter);
            const rightEAR = eyeAspectRatio(rightTop, rightBot, rightInner, rightOuter);
            const avgEAR   = (leftEAR + rightEAR) / 2;

            if (avgEAR < EAR_BLINK_THRESHOLD) {
              // Eyes closed = blink detected
              lastBlinkAtRef.current = Date.now();
            }

            // Flag if no blink for a long time (photo / video loop spoofing)
            const timeSinceBlink = Date.now() - lastBlinkAtRef.current;
            if (timeSinceBlink > LIVENESS_BLINK_WINDOW_MS) {
              emitViolation("no_blink_detected", "⚠️ Liveness check failed — no blink detected.");
            }
          }

          // ── 4. Iris gaze estimation ──────────────────────────────────────
          const leftIris   = lm[LEFT_IRIS_CENTER];
          const rightIris  = lm[RIGHT_IRIS_CENTER];

          if (leftIris && rightIris && leftInner && leftOuter && rightInner && rightOuter && leftTop && leftBot && rightTop && rightBot) {
            const leftGaze  = gazeOffset(leftIris,  leftInner,  leftOuter,  leftTop,  leftBot);
            const rightGaze = gazeOffset(rightIris, rightInner, rightOuter, rightTop, rightBot);

            const avgOffsetX = (leftGaze.offsetX  + rightGaze.offsetX)  / 2;
            const avgOffsetY = (leftGaze.offsetY  + rightGaze.offsetY)  / 2;

            if (Math.abs(avgOffsetX) > GAZE_H_THRESHOLD || Math.abs(avgOffsetY) > GAZE_V_THRESHOLD) {
              emitViolation("gaze_off_screen", "⚠️ Gaze off screen!");
            } else {
              clearStreak();
            }
          } else {
            // Iris landmarks absent — fall back to coarse nose-based check
            const nose = lm[1];
            if (nose && (nose.x < 0.2 || nose.x > 0.8 || nose.y < 0.1 || nose.y > 0.9)) {
              emitViolation("looking_away", "⚠️ Looking away!");
            } else {
              clearStreak();
            }
          }
        } catch {
          // Transient frame error — continue
        }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    // ── Camera setup ─────────────────────────────────────────────────────────
    const startCam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" },
          audio: true, // grab audio here so the AudioGuard can reuse it
        });
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        onStreamReadyRef.current?.(stream);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          const onReady = () => {
            if (!active) return;
            void videoRef.current?.play().catch(() => {});
            setStatus("Face & Gaze Tracking Active");
            lastBlinkAtRef.current = Date.now(); // start liveness clock
            animFrameRef.current = requestAnimationFrame(loop);
          };
          if (videoRef.current.readyState >= 1) onReady();
          else videoRef.current.onloadedmetadata = onReady;
        }
      } catch {
        if (active) setStatus("Webcam error");
      }
    };

    // ── Model loading ─────────────────────────────────────────────────────────
    async function loadModel() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm",
        );
        const modelAssetPath =
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

        let landmarker: FaceLandmarker;
        const opts = {
          baseOptions: { modelAssetPath, delegate: "GPU" as const },
          runningMode: "VIDEO" as const,
          numFaces: 2,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        };

        try {
          landmarker = await FaceLandmarker.createFromOptions(vision, opts);
        } catch {
          landmarker = await FaceLandmarker.createFromOptions(vision, {
            ...opts,
            baseOptions: { modelAssetPath, delegate: "CPU" as const },
          });
        }

        if (!active) { try { landmarker.close(); } catch { /**/ } return; }

        landmarkerRef.current = landmarker;
        await startCam();
      } catch {
        if (active) setStatus("MediaPipe failed to load");
      }
    }

    void loadModel();

    return () => {
      active = false;
      if (animFrameRef.current)   cancelAnimationFrame(animFrameRef.current);
      if (landmarkerRef.current)  { try { landmarkerRef.current.close();  } catch { /**/ } landmarkerRef.current = null; }
      if (streamRef.current)      { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
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