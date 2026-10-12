/**
 * Suppresses MediaPipe and TensorFlow Lite internal C++ runtime messages that
 * are printed to stderr and erroneously intercepted as errors by Next.js Turbopack dev overlay.
 */
export function suppressMediaPipeConsoleErrors() {
  if (typeof window === "undefined") return;

  const originalConsoleError = console.error;
  // Prevent double wrapping
  if ((console.error as { __is_mediapipe_filter__?: boolean }).__is_mediapipe_filter__) {
    return;
  }

  const filteredConsoleError = function (...args: unknown[]) {
    const isBenignMediaPipeMsg = args.some((arg) => {
      if (typeof arg !== "string") return false;
      return (
        arg.includes("TensorFlow Lite") ||
        arg.includes("XNNPACK delegate") ||
        arg.includes("INFO:") ||
        arg.includes("Created TensorFlow") ||
        arg.includes("gl_context") ||
        arg.includes("GL context") ||
        arg.includes("delegate (TfLite") ||
        arg.includes("InitGoogleLogging")
      );
    });

    if (isBenignMediaPipeMsg) {
      // Downgrade to console.info so developers can still see it in browser devtools
      // without triggering Next.js dev error overlay
      console.info(...args);
      return;
    }

    originalConsoleError.apply(console, args);
  };

  (filteredConsoleError as { __is_mediapipe_filter__?: boolean }).__is_mediapipe_filter__ = true;
  console.error = filteredConsoleError;
}
