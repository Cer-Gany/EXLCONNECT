"use client";

import { useCallback, useEffect, useRef } from "react";

// ── Tuning constants ───────────────────────────────────────────────────────────
// Speech energy lives in the 300 Hz – 4 kHz band.
// We poll the FFT every POLL_INTERVAL_MS, and only fire a violation after
// SUSTAINED_FRAMES consecutive samples above threshold (avoids one-shot noise).
const POLL_INTERVAL_MS = 600;
const SUSTAINED_FRAMES_THRESHOLD = 4; // ~2.4 s of continuous speech-energy
const SILENCE_FRAMES_RESET = 3; // clear streak after 3 quiet frames
const SPEECH_RMS_THRESHOLD = 0.018; // 0–1 scale; tune up if too noisy

// Cooldown between firing the same violation twice
const VIOLATION_COOLDOWN_MS = 10_000;

export type AudioViolationType = "suspicious_audio" | "loud_sound";

export interface AudioGuardOptions {
  enabled?: boolean;
  onViolation?: (type: AudioViolationType, detail: string) => void;
  /** Existing MediaStream from the proctoring camera – reuse its audio track
   *  to avoid a second getUserMedia() permission prompt. Falls back to a fresh
   *  getUserMedia if not provided. */
  existingStream?: MediaStream | null;
  /** Set to true while the AI interviewer is speaking via TTS. The guard will
   *  suppress suspicious_audio violations during this window to avoid
   *  false-positives from the AI voice being picked up by the mic. */
  isSpeaking?: boolean;
}

/**
 * useAudioGuard
 *
 * Runs a lightweight Web Audio analyser on the candidate's microphone.
 * Detects sustained speech-band energy (whispering, someone in the room
 * answering questions) and fires `onViolation("suspicious_audio", ...)`.
 *
 * CPU cost: ~0.5–1 % (AnalyserNode, no ML model, no AudioWorklet required).
 */
export function useAudioGuard({
  enabled = true,
  onViolation,
  existingStream,
  isSpeaking = false,
}: AudioGuardOptions = {}) {
  const onViolationRef  = useRef(onViolation);
  const isSpeakingRef   = useRef(isSpeaking);
  useEffect(() => { onViolationRef.current = onViolation; }, [onViolation]);
  useEffect(() => { isSpeakingRef.current  = isSpeaking;  }, [isSpeaking]);

  const lastFiredRef = useRef<Record<AudioViolationType, number>>({
    suspicious_audio: 0,
    loud_sound: 0,
  });

  const emit = useCallback((type: AudioViolationType, detail: string) => {
    const now = Date.now();
    if (now - lastFiredRef.current[type] < VIOLATION_COOLDOWN_MS) return;
    lastFiredRef.current[type] = now;
    onViolationRef.current?.(type, detail);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let audioCtx: AudioContext | null = null;
    let ownedStream: MediaStream | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    let speechStreak = 0;
    let silenceStreak = 0;

    async function init() {
      try {
        let stream: MediaStream;

        if (existingStream && existingStream.getAudioTracks().length > 0) {
          stream = existingStream;
        } else {
          // Only request audio — camera is already handled by MediaPipeGuard
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          if (!active) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          ownedStream = stream;
        }

        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256; // 128 bins, fast
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);

        const bufferLength = analyser.frequencyBinCount; // 128
        const dataArray = new Uint8Array(bufferLength);

        // Determine which FFT bins correspond to 300 Hz – 4000 Hz
        const nyquist = audioCtx.sampleRate / 2;
        const binHz = nyquist / bufferLength;
        const lowBin = Math.floor(300 / binHz);
        const highBin = Math.min(bufferLength - 1, Math.ceil(4000 / binHz));

        intervalId = setInterval(() => {
          if (!active || !analyser) return;

          analyser.getByteFrequencyData(dataArray);

          // Compute RMS of speech band
          let sum = 0;
          const count = highBin - lowBin + 1;
          for (let i = lowBin; i <= highBin; i++) {
            const norm = (dataArray[i] ?? 0) / 255;
            sum += norm * norm;
          }
          const rms = Math.sqrt(sum / count);

          if (rms > SPEECH_RMS_THRESHOLD) {
            silenceStreak = 0;
            speechStreak++;

            if (speechStreak >= SUSTAINED_FRAMES_THRESHOLD) {
              // Suppress while the AI interviewer is speaking — its voice
              // leaks into the mic and would cause constant false positives.
              if (!isSpeakingRef.current) {
                emit(
                  "suspicious_audio",
                  `Sustained speech-like audio detected (level: ${(rms * 100).toFixed(0)}%)`,
                );
              }
              speechStreak = 0;
            }
          } else {
            silenceStreak++;
            if (silenceStreak >= SILENCE_FRAMES_RESET) {
              speechStreak = 0;
            }
          }

          // Separately detect abrupt loud sounds (non-speech, e.g. a door knock or
          // someone shouting — high energy across all bins)
          let totalRms = 0;
          for (let i = 0; i < bufferLength; i++) {
            const norm = (dataArray[i] ?? 0) / 255;
            totalRms += norm * norm;
          }
          totalRms = Math.sqrt(totalRms / bufferLength);
          if (totalRms > 0.35) {
            emit("loud_sound", `Sudden loud sound detected (level: ${(totalRms * 100).toFixed(0)}%)`);
          }
        }, POLL_INTERVAL_MS);
      } catch {
        // Microphone access denied or not available — fail silently
      }
    }

    void init();

    return () => {
      active = false;
      if (intervalId) clearInterval(intervalId);
      if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
      }
      if (ownedStream) {
        ownedStream.getTracks().forEach((t) => t.stop());
        ownedStream = null;
      }
    };
  }, [enabled, existingStream, emit]);
}
