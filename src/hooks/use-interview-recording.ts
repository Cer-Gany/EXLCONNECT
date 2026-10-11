"use client";

import { createLogger } from "@/lib/logger";
import {
    getStoredCameraStream,
    getStoredScreenStream,
    setStoredCameraStream,
    setStoredScreenStream,
    wasCameraSkipped,
    wasScreenSkipped,
} from "@/lib/media-stream-store";
import fixWebmDuration from "fix-webm-duration";
import { useCallback, useEffect, useRef, useState } from "react";

const log = createLogger("recording");

export interface ScreenshotEntry {
  url: string;
  path: string;
  timestamp: string;
  type: "camera" | "screen";
}

interface UseInterviewRecordingOptions {
  sessionId: string;
  enabled: boolean;
  screenshotIntervalMs?: number;
}

/**
 * Resolve the actual playable duration of a WebM audio blob.
 * WebM files from MediaRecorder often have Infinity/missing duration;
 * the seek-to-end trick forces the browser to compute it.
 */
function stopMediaRecorderSafely(
  recorder: MediaRecorder,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve) => {
    if (recorder.state === "inactive") {
      resolve();
      return;
    }

    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    const timeout = setTimeout(() => {
      log.warn(`${label} recorder stop timed out; continuing cleanup`);
      finish();
    }, timeoutMs);

    recorder.addEventListener("stop", finish, { once: true });
    recorder.addEventListener("error", (event) => {
      log.warn(`${label} recorder emitted an error while stopping`, event);
      // MediaRecorder normally emits a final dataavailable before stop. Keep
      // waiting for stop (or the timeout) so those final chunks are retained.
    }, { once: true });

    try {
      recorder.stop();
    } catch (err) {
      log.warn(`${label} recorder stop failed; continuing cleanup`, err);
      finish();
    }
  });
}

function resolveBlobDuration(blob: Blob): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const isVideo = blob.type.startsWith("video/");
    const media = document.createElement(isVideo ? "video" : "audio");
    media.muted = true;
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; cleanup(); resolve(undefined); }
    }, 5000);

    function cleanup() {
      clearTimeout(timeout);
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(url);
    }

    function finish(dur: number) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(Math.max(1, Math.round(dur)));
    }

    media.addEventListener("durationchange", () => {
      if (media.duration && isFinite(media.duration) && media.duration < 1e8) {
        finish(media.duration);
      }
    });

    media.addEventListener("loadedmetadata", () => {
      if (media.duration && isFinite(media.duration) && media.duration < 1e8) {
        finish(media.duration);
      } else {
        media.currentTime = 1e10;
      }
    });

    media.preload = "auto";
    media.src = url;
  });
}

/**
 * Manages audio recording (combined mic + TTS), camera/screen streams,
 * and periodic screenshot capture during a voice interview.
 *
 * Audio mixing strategy:
 *   - A single AudioContext drives a MediaStreamAudioDestinationNode.
 *   - The mic MediaStream is piped in via createMediaStreamSource.
 *   - TTS PCM chunks (int16 @ 24 kHz) are decoded into AudioBuffers
 *     and played into the same destination via BufferSourceNodes.
 *   - MediaRecorder records the destination's combined stream as webm/opus.
 */
export function useInterviewRecording({
  sessionId,
  enabled,
  screenshotIntervalMs = 60_000,
}: UseInterviewRecordingOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  // Refs for recording infrastructure
  const recorderRef = useRef<MediaRecorder | null>(null);
  const screenRecorderRef = useRef<MediaRecorder | null>(null);
  const cameraRecorderRef = useRef<MediaRecorder | null>(null);
  const screenChunksRef = useRef<Blob[]>([]);
  const cameraChunksRef = useRef<Blob[]>([]);
  const screenMimeRef = useRef<string>("");
  const cameraMimeRef = useRef<string>("");
  const cameraStartedAtRef = useRef<number>(0);
  const screenStartedAtRef = useRef<number>(0);
  const chunksRef = useRef<Blob[]>([]);
  const audioMimeRef = useRef<string>("");
  const mixCtxRef = useRef<AudioContext | null>(null);
  const mixDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const screenshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenshotsRef = useRef<ScreenshotEntry[]>([]);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const stoppedRef = useRef(false);
  const stopPromiseRef = useRef<Promise<{
    audioUrl?: string;
    audioDuration?: number;
    screenRecordingUrl?: string;
    cameraRecordingUrl?: string;
    screenshots: ScreenshotEntry[];
  }> | null>(null);
  const ttsPlayTimeRef = useRef(0);
  const ttsSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Keep refs in sync with state
  useEffect(() => { cameraStreamRef.current = cameraStream; }, [cameraStream]);
  useEffect(() => { screenStreamRef.current = screenStream; }, [screenStream]);

  /** Acquire camera and screen streams, reusing stored streams from onboarding. */
  const acquireStreams = useCallback(async () => {
    // Reuse camera stream from onboarding if still active
    const storedCam = getStoredCameraStream();
    if (storedCam) {
      setCameraStream(storedCam);
      cameraStreamRef.current = storedCam;
      setStoredCameraStream(null);
    } else if (!wasCameraSkipped()) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 640, height: 480 },
        });
        setCameraStream(cam);
        cameraStreamRef.current = cam;
      } catch (err) {
        log.warn("Camera not available:", err);
      }
    }

    // Reuse screen stream from onboarding if still active
    const storedScreen = getStoredScreenStream();
    if (storedScreen) {
      setScreenStream(storedScreen);
      screenStreamRef.current = storedScreen;
      setStoredScreenStream(null);

      storedScreen.getVideoTracks()[0]?.addEventListener("ended", () => {
        setScreenStream(null);
        screenStreamRef.current = null;
      });
    } else if (!wasScreenSkipped()) {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
        setScreenStream(screen);
        screenStreamRef.current = screen;

        screen.getVideoTracks()[0]?.addEventListener("ended", () => {
          setScreenStream(null);
          screenStreamRef.current = null;
        });
      } catch (err) {
        log.warn("Screen share not available:", err);
      }
    }
  }, []);

  /** Start continuous screen video recording using the already-acquired screen stream. */
  const startCameraRecording = useCallback(() => {
    const camera = cameraStreamRef.current;

    if (!camera) {
      log.warn("Cannot start camera recording: camera stream unavailable");
      return;
    }

    if (
      cameraRecorderRef.current &&
      cameraRecorderRef.current.state !== "inactive"
    ) {
      return;
    }

    const mimeCandidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];

    const mimeType = mimeCandidates.find((mime) =>
      MediaRecorder.isTypeSupported(mime),
    );

    if (!mimeType) {
      log.error("No supported camera recording MIME type found");
      return;
    }

    cameraChunksRef.current = [];
    cameraMimeRef.current = mimeType;

    const recorder = new MediaRecorder(camera, {
      mimeType,
    });

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        cameraChunksRef.current.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      log.error("Camera recorder error:", event);
    };

    recorder.onstop = () => {
      log.info(
        "Camera recording stopped. Chunks:",
        cameraChunksRef.current.length,
      );
    };

    recorder.start(5000);
    cameraStartedAtRef.current = Date.now();
    cameraRecorderRef.current = recorder;

    log.info("Camera video recording started:", mimeType);
  }, []);

  const startScreenRecording = useCallback(() => {
    const screen = screenStreamRef.current;

    if (!screen) {
      log.warn("Cannot start screen recording: screen stream unavailable");
      return;
    }

    if (
      screenRecorderRef.current &&
      screenRecorderRef.current.state !== "inactive"
    ) {
      return;
    }

    const mimeCandidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];

    const mimeType = mimeCandidates.find((mime) =>
      MediaRecorder.isTypeSupported(mime),
    );

    if (!mimeType) {
      log.error("No supported screen recording MIME type found");
      return;
    }

    screenChunksRef.current = [];
    screenMimeRef.current = mimeType;

    const recorder = new MediaRecorder(screen, {
      mimeType,
    });

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        screenChunksRef.current.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      log.error("Screen recorder error:", event);
    };

    recorder.onstop = () => {
      log.info(
        "Screen recording stopped. Chunks:",
        screenChunksRef.current.length,
      );
    };

    recorder.start(5000);
    screenStartedAtRef.current = Date.now();
    screenRecorderRef.current = recorder;

    log.info("Screen video recording started:", mimeType);
  }, []);

  /** Pipe a mic MediaStream into the recording mixer. */
  const attachMicStream = useCallback((micStream: MediaStream) => {
    const ctx = mixCtxRef.current;
    if (!ctx || !mixDestRef.current) return;

    // Disconnect previous mic source if any
    try { micSourceRef.current?.disconnect(); } catch { /* noop */ }

    const source = ctx.createMediaStreamSource(micStream);
    source.connect(mixDestRef.current);
    micSourceRef.current = source;
  }, []);

  /**
   * Feed a TTS PCM chunk (int16 @ 24 kHz) into the recording mixer.
   * Chunks are scheduled sequentially to avoid overlapping audio.
   */
  const addTtsChunk = useCallback((pcmData: ArrayBuffer) => {
    const ctx = mixCtxRef.current;
    const dest = mixDestRef.current;
    if (!ctx || !dest || pcmData.byteLength === 0) return;

    const int16 = new Int16Array(pcmData);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const sampleRate = 24000;
    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(dest);

    const startAt = Math.max(ctx.currentTime, ttsPlayTimeRef.current);
    source.start(startAt);
    ttsPlayTimeRef.current = startAt + audioBuffer.duration;

    ttsSourcesRef.current.push(source);
    source.onended = () => {
      ttsSourcesRef.current = ttsSourcesRef.current.filter((s) => s !== source);
    };
  }, []);

  /**
   * Cancel all scheduled TTS sources in the recording mixer.
   * Must be called when the user interrupts the agent so the recording
   * only contains audio that was actually heard.
   */
  const cancelTts = useCallback(() => {
    for (const source of ttsSourcesRef.current) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    ttsSourcesRef.current = [];
    ttsPlayTimeRef.current = 0;
  }, []);

  /** Capture a screenshot from a video element and upload it. */
  const captureAndUpload = useCallback(
    async (video: HTMLVideoElement, type: "camera" | "screen") => {
      if (video.readyState < 2 || video.videoWidth === 0) return;

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;

      if (type === "camera") {
        ctx2d.translate(canvas.width, 0);
        ctx2d.scale(-1, 1);
      }
      ctx2d.drawImage(video, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7),
      );
      if (!blob) return;

      const timestamp = new Date().toISOString();
      const filename = `${timestamp.replace(/[:.]/g, "-")}-${type}.jpg`;

      let screenshotTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const form = new FormData();
        form.append("file", blob, filename);
        form.append("sessionId", sessionId);
        form.append("type", "screenshot");
        form.append("filename", filename);

        const controller = new AbortController();
        screenshotTimeout = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch("/api/session/upload", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          screenshotsRef.current.push({
            url: data.url,
            path: data.path,
            timestamp,
            type,
          });
          log.info(`Screenshot uploaded: ${type}`);
        }
      } catch (err) {
        log.error("Screenshot upload failed:", err);
      } finally {
        if (screenshotTimeout) clearTimeout(screenshotTimeout);
      }
    },
    [sessionId],
  );

  /** Take screenshots from both camera and screen streams. */
  const takeScreenshots = useCallback(() => {
    const pending: Promise<void>[] = [];
    if (cameraVideoRef.current && cameraStreamRef.current) {
      pending.push(captureAndUpload(cameraVideoRef.current, "camera"));
    }
    if (screenVideoRef.current && screenStreamRef.current) {
      pending.push(captureAndUpload(screenVideoRef.current, "screen"));
    }
    return Promise.all(pending).then(() => undefined);
  }, [captureAndUpload]);

  /**
   * Capture lightweight JPEG data URLs from the active camera & screen streams
   * for one-way live recruiter monitoring (without disk/storage uploads).
   */
  const captureLiveFrames = useCallback((): {
    cameraFrame?: string;
    screenFrame?: string;
  } => {
    const snap = (
      video: HTMLVideoElement | null,
      maxW: number,
      mirror: boolean,
    ): string | undefined => {
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        return undefined;
      }
      const scale = Math.min(1, maxW / video.videoWidth);
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const h = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return undefined;
      if (mirror) {
        ctx2d.translate(w, 0);
        ctx2d.scale(-1, 1);
      }
      ctx2d.drawImage(video, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.52);
    };

    return {
      cameraFrame: snap(cameraVideoRef.current, 360, true),
      screenFrame: snap(screenVideoRef.current, 640, false),
    };
  }, []);

  /** Start recording audio and periodic screenshots. */
  const start = useCallback(
    async (micStream?: MediaStream) => {
      if (!enabled || isRecording) return;
      stoppedRef.current = false;
      ttsPlayTimeRef.current = 0;

      // Create mixing AudioContext and destination
      const ctx = new AudioContext();
      mixCtxRef.current = ctx;
      const dest = ctx.createMediaStreamDestination();
      mixDestRef.current = dest;

      // Attach mic if provided
      if (micStream) {
        attachMicStream(micStream);
      }

      // Start MediaRecorder — prefer MP4/AAC (iOS-compatible) with WebM fallback
      chunksRef.current = [];
      const preferredMime = ["audio/mp4", "audio/mp4;codecs=aac", "audio/webm;codecs=opus", "audio/webm"]
        .find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      audioMimeRef.current = preferredMime;
      log.info("Recording MIME:", preferredMime || "(default)");
      const recorder = new MediaRecorder(dest.stream, {
        ...(preferredMime ? { mimeType: preferredMime } : {}),
      });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(5000); // collect chunks every 5s
      recorderRef.current = recorder;

      // Acquire camera + screen
      await acquireStreams();

      // End Interview may have been pressed while the permission/reuse flow
      // was pending. Do not start new recorders after finalization began.
      if (stoppedRef.current) {
        cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
        screenStreamRef.current?.getTracks().forEach((track) => track.stop());
        setCameraStream(null);
        setScreenStream(null);
        return;
      }

      // Start continuous camera and screen video recordings.
      startCameraRecording();
      startScreenRecording();

      // Set up hidden video elements for screenshot capture
      if (!cameraVideoRef.current) {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.style.display = "none";
        document.body.appendChild(v);
        cameraVideoRef.current = v;
      }
      if (!screenVideoRef.current) {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.style.display = "none";
        document.body.appendChild(v);
        screenVideoRef.current = v;
      }

      // Bind streams to hidden video elements for canvas capture
      const bindStream = (video: HTMLVideoElement, stream: MediaStream | null) => {
        if (stream) {
          video.srcObject = stream;
          video.play().catch(() => {});
        }
      };
      // Use refs (set in acquireStreams via state update + useEffect sync)
      // Small delay to let state sync
      setTimeout(() => {
        bindStream(cameraVideoRef.current!, cameraStreamRef.current);
        bindStream(screenVideoRef.current!, screenStreamRef.current);
      }, 500);

      // Start periodic screenshot timer
      screenshotTimerRef.current = setInterval(() => { void takeScreenshots(); }, screenshotIntervalMs);

      setIsRecording(true);
      log.info("Started");
    },
    [
      enabled,
      isRecording,
      acquireStreams,
      attachMicStream,
      startCameraRecording,
      startScreenRecording,
      takeScreenshots,
      screenshotIntervalMs,
    ],
  );

  /**
   * Stop recording. Uploads the audio blob and returns recording metadata.
   * Returns the list of screenshot entries.
   */
  const stop = useCallback(async (): Promise<{
    audioUrl?: string;
    audioDuration?: number;
    screenRecordingUrl?: string;
    cameraRecordingUrl?: string;
    screenshots: ScreenshotEntry[];
  }> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    if (stoppedRef.current) return { screenshots: screenshotsRef.current };
    stoppedRef.current = true;

    const finalize = async () => {

    // Stop screenshot timer
    if (screenshotTimerRef.current) {
      clearInterval(screenshotTimerRef.current);
      screenshotTimerRef.current = null;
    }

    // Capture metadata/screenshots before the source tracks are released.
    await takeScreenshots();

    // Stop MediaRecorder and collect audio
    let audioDuration: number | undefined;
    const recorder = recorderRef.current;
    const cameraRecorder = cameraRecorderRef.current;
    const screenRecorder = screenRecorderRef.current;
    const stoppedAtMs = Date.now();
    // Stop every recorder before doing duration parsing or network I/O. Each
    // stop promise resolves on stop or a bounded timeout, and stop's final
    // dataavailable event is delivered before its stop event.
    await Promise.all([
      recorder ? stopMediaRecorderSafely(recorder, "Audio") : Promise.resolve(),
      cameraRecorder ? stopMediaRecorderSafely(cameraRecorder, "Camera") : Promise.resolve(),
      screenRecorder ? stopMediaRecorderSafely(screenRecorder, "Screen") : Promise.resolve(),
    ]);

    // Once all final dataavailable/stop events have fired, release capture
    // devices before parsing blobs or waiting on storage.
    try { micSourceRef.current?.disconnect(); } catch { /* already disconnected */ }
    micSourceRef.current = null;
    const mixContext = mixCtxRef.current;
    mixCtxRef.current = null;
    if (mixContext && mixContext.state !== "closed") {
      try { await mixContext.close(); } catch (error) {
        log.warn("Audio mixer context close failed", error);
      }
    }
    mixDestRef.current = null;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setScreenStream(null);

    const uploadRecording = async (blob: Blob, filename: string): Promise<string | undefined> => {
      const form = new FormData();
      form.append("file", blob, filename);
      form.append("sessionId", sessionId);
      form.append("type", "recording");
      form.append("filename", filename);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 480_000);
      const startedAt = Date.now();
      try {
        const response = await fetch("/api/session/upload", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        const data = await response.json();
        log.info(`Uploaded ${filename} (${blob.size} bytes) in ${Date.now() - startedAt}ms`);
        return data.url as string;
      } catch (error) {
        if (controller.signal.aborted) {
          log.error(`Upload request timed out for ${filename} (${blob.size} bytes); storage outcome may be unknown`);
        } else {
          log.error(`Upload failed for ${filename} (${blob.size} bytes)`, error);
        }
        return undefined;
      } finally {
        clearTimeout(timeout);
      }
    };

    let audioBlob: Blob | undefined;
    if (recorder) {
      const mime = audioMimeRef.current || "audio/webm";
      const isWebm = mime.includes("webm");
      const rawBlob = new Blob(chunksRef.current, { type: mime });
      if (rawBlob.size > 0) {
        audioDuration = await resolveBlobDuration(rawBlob);

        // Patch WebM container with correct duration so players can display it
        audioBlob = (isWebm && audioDuration)
          ? await fixWebmDuration(rawBlob, audioDuration * 1000)
          : rawBlob;

      }
    }

    // Build every final blob (and patch WebM duration headers on camera & screen videos)
    // before starting independent storage requests.
    const videoUploads: Promise<string | undefined>[] = [];
    const cameraUploadIndex = cameraChunksRef.current.length > 0 ? videoUploads.length : -1;
    const cameraMime = cameraMimeRef.current || "video/webm";
    const rawCameraBlob = new Blob(cameraChunksRef.current, {
      type: cameraMime,
    });
    if (rawCameraBlob.size > 0) {
      const elapsedCameraMs = cameraStartedAtRef.current > 0
        ? Math.max(1000, stoppedAtMs - cameraStartedAtRef.current)
        : (audioDuration ? audioDuration * 1000 : undefined);
      const resolvedCamSec = await resolveBlobDuration(rawCameraBlob);
      const cameraDurationMs = resolvedCamSec ? resolvedCamSec * 1000 : elapsedCameraMs;
      const cameraBlob =
        cameraMime.includes("webm") && cameraDurationMs
          ? await fixWebmDuration(rawCameraBlob, cameraDurationMs).catch(() => rawCameraBlob)
          : rawCameraBlob;
      videoUploads.push(uploadRecording(cameraBlob, `camera-recording-${Date.now()}.webm`));
    }

    cameraRecorderRef.current = null;
    cameraChunksRef.current = [];
    cameraMimeRef.current = "";
    cameraStartedAtRef.current = 0;

    const screenUploadIndex = screenChunksRef.current.length > 0 ? videoUploads.length : -1;
    const screenMime = screenMimeRef.current || "video/webm";
    const rawScreenBlob = new Blob(screenChunksRef.current, {
      type: screenMime,
    });

    if (rawScreenBlob.size > 0) {
      const elapsedScreenMs = screenStartedAtRef.current > 0
        ? Math.max(1000, stoppedAtMs - screenStartedAtRef.current)
        : (audioDuration ? audioDuration * 1000 : undefined);
      const resolvedScreenSec = await resolveBlobDuration(rawScreenBlob);
      const screenDurationMs = resolvedScreenSec ? resolvedScreenSec * 1000 : elapsedScreenMs;
      const screenBlob =
        screenMime.includes("webm") && screenDurationMs
          ? await fixWebmDuration(rawScreenBlob, screenDurationMs).catch(() => rawScreenBlob)
          : rawScreenBlob;
      videoUploads.push(uploadRecording(screenBlob, `screen-recording-${Date.now()}.webm`));
    }

    let audioUpload: Promise<string | undefined> = Promise.resolve(undefined);
    if (audioBlob?.size) audioUpload = uploadRecording(audioBlob, `recording-${Date.now()}.${audioMimeRef.current.includes("webm") ? "webm" : "m4a"}`);
    const [audioResult, videoResults] = await Promise.all([audioUpload, Promise.all(videoUploads)]);
    const audioUrl = audioResult;
    const cameraRecordingUrl = cameraUploadIndex >= 0 ? videoResults[cameraUploadIndex] : undefined;
    const screenRecordingUrl = screenUploadIndex >= 0 ? videoResults[screenUploadIndex] : undefined;

    screenRecorderRef.current = null;
    screenChunksRef.current = [];
    screenMimeRef.current = "";
    screenStartedAtRef.current = 0;

    recorderRef.current = null;

    // Clean up hidden video elements
    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null;
      cameraVideoRef.current.remove();
      cameraVideoRef.current = null;
    }
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null;
      screenVideoRef.current.remove();
      screenVideoRef.current = null;
    }

    setIsRecording(false);
    log.info("Stopped");

    return {
      audioUrl,
      audioDuration,
      screenRecordingUrl,
      cameraRecordingUrl,
      screenshots: screenshotsRef.current,
    };
    };

    stopPromiseRef.current = finalize().catch((error) => {
      log.error("Recording finalization failed", error);
      // Stop and release devices even if blob processing or uploads fail.
      for (const active of [recorderRef.current, cameraRecorderRef.current, screenRecorderRef.current]) {
        if (active && active.state !== "inactive") {
          try { active.stop(); } catch { /* already stopping */ }
        }
      }
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      try { micSourceRef.current?.disconnect(); } catch { /* already disconnected */ }
      micSourceRef.current = null;
      const context = mixCtxRef.current;
      mixCtxRef.current = null;
      if (context && context.state !== "closed") {
        void context.close().catch((closeError) => log.warn("Audio mixer context close failed", closeError));
      }
      mixDestRef.current = null;
      if (screenshotTimerRef.current) clearInterval(screenshotTimerRef.current);
      screenshotTimerRef.current = null;
      for (const video of [cameraVideoRef.current, screenVideoRef.current]) {
        if (video) {
          video.srcObject = null;
          video.remove();
        }
      }
      cameraVideoRef.current = null;
      screenVideoRef.current = null;
      setCameraStream(null);
      setScreenStream(null);
      setIsRecording(false);
      return { screenshots: screenshotsRef.current };
    });
    return stopPromiseRef.current;
  }, [sessionId, takeScreenshots]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (screenshotTimerRef.current) clearInterval(screenshotTimerRef.current);
      try { recorderRef.current?.stop(); } catch { /* noop */ }
      try { micSourceRef.current?.disconnect(); } catch { /* noop */ }
      const mixContext = mixCtxRef.current;
      mixCtxRef.current = null;
      if (mixContext && mixContext.state !== "closed") {
        void mixContext.close().catch((error) => log.warn("Audio mixer context close failed", error));
      }
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (cameraVideoRef.current) { cameraVideoRef.current.remove(); cameraVideoRef.current = null; }
      if (screenVideoRef.current) { screenVideoRef.current.remove(); screenVideoRef.current = null; }
    };
  }, []);

  return {
    start,
    stop,
    addTtsChunk,
    cancelTts,
    attachMicStream,
    captureLiveFrames,
    cameraStream,
    screenStream,
    isRecording,
    screenshots: screenshotsRef,
  };
}
