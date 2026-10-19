import assert from "node:assert/strict";
import test from "node:test";

import { decideChatAdaptiveRoute } from "../src/lib/adaptive/chat-routing";

test("weak adaptive chat answers receive one bounded clarification", () => {
  assert.deepEqual(
    decideChatAdaptiveRoute({
      score: 3,
      depth: "adequate",
      followUpsUsed: 0,
      nextIndex: 4,
      shouldEnd: false,
    }),
    { kind: "follow_up", reason: "weak" },
  );
});

test("surface answers receive a clarification even when score is neutral", () => {
  assert.deepEqual(
    decideChatAdaptiveRoute({
      score: 5,
      depth: "surface",
      followUpsUsed: 0,
      nextIndex: 2,
      shouldEnd: false,
    }),
    { kind: "follow_up", reason: "surface" },
  );
});

test("a second weak answer cannot create an unbounded follow-up loop", () => {
  assert.deepEqual(
    decideChatAdaptiveRoute({
      score: 2,
      depth: "surface",
      followUpsUsed: 1,
      nextIndex: 3,
      shouldEnd: false,
    }),
    { kind: "next", index: 3 },
  );
});

test("adaptive completion takes precedence after the follow-up budget is used", () => {
  assert.deepEqual(
    decideChatAdaptiveRoute({
      score: 4,
      depth: "adequate",
      followUpsUsed: 1,
      nextIndex: 3,
      shouldEnd: true,
    }),
    { kind: "complete" },
  );
});

test("strong answers route to the selected adaptive question", () => {
  assert.deepEqual(
    decideChatAdaptiveRoute({
      score: 9,
      depth: "deep",
      followUpsUsed: 0,
      nextIndex: 6,
      shouldEnd: false,
    }),
    { kind: "next", index: 6 },
  );
});
