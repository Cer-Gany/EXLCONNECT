import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is missing");
}

const ai = new GoogleGenAI({ apiKey });

async function main() {
  console.log("Connecting to Gemini Live...");

  const session = await ai.live.connect({
    model: "gemini-3.8-live",
    callbacks: {
      onopen: () => {
        console.log("✅ Gemini Live connected");
      },

      onmessage: (message) => {
        console.log("📩 Gemini event received");
        console.log(JSON.stringify(message, null, 2));
      },

      onerror: (error) => {
        console.error("❌ Gemini error:", error);
      },

      onclose: (event) => {
        console.log("🔌 Gemini connection closed:", event.reason);
      },
    },

    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction:
        "You are a short mic test assistant. Respond briefly.",
    },
  });

  console.log("✅ Gemini Live session created");

  session.sendRealtimeInput({
    text: "Say hello briefly.",
  });

  setTimeout(() => {
    session.close();
    console.log("Test finished.");
  }, 10000);
}

main().catch((error) => {
  console.error("❌ Failed:", error);
  process.exit(1);
});