"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface VideoRecorderProps {
  sessionId?: string;
  autoStart?: boolean;
}

export default function VideoRecorder({
  sessionId = "session-001",
  autoStart = true,
}: VideoRecorderProps) {
  const [recordingState, setRecordingState] = useState("Idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("video/webm");
  const mountedRef = useRef(true);

  const safeSetState = useCallback((next: string) => {
    if (mountedRef.current) {
      setRecordingState(next);
    }
  }, []);

  const uploadToSupabase = useCallback(
    async (blob: Blob) => {
      if (blob.size === 0) {
        safeSetState("Empty recording");
        return;
      }

      const ext = mimeTypeRef.current.includes("mp4") ? "mp4" : "webm";
      const filename = `recording-${Date.now()}.${ext}`;

      try {
        if (UUID_REGEX.test(sessionId)) {
          const form = new FormData();
          form.append("file", blob, filename);
          form.append("sessionId", sessionId);
          form.append("type", "recording");
          form.append("filename", filename);

          const res = await fetch("/api/session/upload", {
            method: "POST",
            body: form,
          });
          if (res.ok) {
            safeSetState("Saved to Cloud ✅");
            return;
          }
        }

        const supabase = createClient();
        const storagePath = `${sessionId}/${filename}`;
        const { error } = await supabase.storage
          .from("recordings")
          .upload(storagePath, blob, {
            contentType: mimeTypeRef.current || "video/webm",
            upsert: true,
          });

        if (error) {
          throw error;
        }
        safeSetState("Saved to Supabase ✅");
      } catch {
        safeSetState("Upload failed ❌");
      }
    },
    [sessionId, safeSetState],
  );

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      try {
        mediaRecorderRef.current.stop();
        safeSetState("Saving...");
      } catch {
        // ignore
      }
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, [safeSetState]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];

      const supportedMime =
        [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm",
          "video/mp4",
        ].find((mime) =>
          typeof MediaRecorder !== "undefined" &&
          typeof MediaRecorder.isTypeSupported === "function"
            ? MediaRecorder.isTypeSupported(mime)
            : false,
        ) ?? "";

      mimeTypeRef.current = supportedMime || "video/webm";

      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: mimeTypeRef.current || "video/webm",
        });
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        await uploadToSupabase(blob);
      };

      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      safeSetState("Recording...");
    } catch {
      safeSetState("Permission denied");
    }
  }, [uploadToSupabase, safeSetState]);

  useEffect(() => {
    mountedRef.current = true;
    if (autoStart) {
      void startRecording();
    }
    return () => {
      mountedRef.current = false;
      stopRecording();
    };
  }, [autoStart, startRecording, stopRecording]);

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 w-48 shadow-lg mt-2">
      <div className="text-xs text-slate-300 flex justify-between items-center">
        <span>Cloud Recorder</span>
        <span className="text-[10px] text-emerald-400 font-bold">
          {recordingState}
        </span>
      </div>
    </div>
  );
}