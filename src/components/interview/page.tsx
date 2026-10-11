"use client";

import MediaPipeGuard from "@/components/proctoring/MediaPipeGuard";
import YoloObjectGuard from "@/components/proctoring/YoloObjectGuard";
import VideoRecorder from "@/components/proctoring/VideoRecorder";

export default function CandidateExamRoom() {
  return (
    <div className="relative min-h-screen bg-slate-950 text-white p-6">
      <h1 className="text-xl font-bold">Assessment Room</h1>

      {/* Floating Proctoring Widget Stack */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end">
        <MediaPipeGuard onViolation={(v) => console.log(v)} />
        <YoloObjectGuard onObjectDetected={(obj) => console.log("Object detected:", obj)} />
        <VideoRecorder sessionId="candidate-user-123" />
      </div>
    </div>
  );
}