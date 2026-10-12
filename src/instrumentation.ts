export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    process.env.NODE_ENV !== "test"
  ) {
    const g = globalThis as typeof globalThis & {
      __auralVoiceRelaySpawned?: boolean;
    };
    if (!g.__auralVoiceRelaySpawned) {
      g.__auralVoiceRelaySpawned = true;
      try {
        const { spawn } = await import(/*turbopackIgnore: true*/ "node:child_process");
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "server/voice-relay.ts"],
          {
            cwd: /*turbopackIgnore: true*/ process.cwd(),
            stdio: "ignore",
            detached: false,
            windowsHide: true,
          },
        );
        child.on("error", () => {
          // Ignore background spawn errors; user can still run `npm run dev:voice` manually.
        });
        child.unref();
      } catch {
        // Ignore if child_process is unavailable in current runtime.
      }
    }
  }
}
