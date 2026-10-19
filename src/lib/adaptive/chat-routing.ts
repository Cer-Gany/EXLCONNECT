import type { ResponseDepth } from "./types";

export type ChatAdaptiveDecision =
  | { kind: "follow_up"; reason: "weak" | "surface" }
  | { kind: "complete" }
  | { kind: "next"; index: number };

export function decideChatAdaptiveRoute(input: {
  score: number;
  depth: ResponseDepth;
  followUpsUsed: number;
  nextIndex: number;
  shouldEnd: boolean;
}): ChatAdaptiveDecision {
  if ((input.score <= 4 || input.depth === "surface") && input.followUpsUsed < 1) {
    return {
      kind: "follow_up",
      reason: input.depth === "surface" ? "surface" : "weak",
    };
  }

  if (input.shouldEnd) {
    return { kind: "complete" };
  }

  return { kind: "next", index: input.nextIndex };
}
