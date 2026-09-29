import { describe, expect, it } from "vitest";
import { isRealtimeCheckingBackchannel } from "./forced-consults.js";

describe("realtime checking backchannels", () => {
  it.each([
    "Let me check what that charge refers to in your records.",
    "Let me check on that for you.",
    "I'm checking the latest status for you now.",
    "I’ll look that up.",
    "I'll take a look at the latest status.",
    "Let me investigate the charge.",
    "I'm going to check the project file.",
    "I will check the project file.",
    "Let me pull that up for you.",
    "Checking that now.",
    "I can verify that in Fi.",
    "One moment, please.",
    "Hold on while I look into that.",
  ])("recognizes an incomplete lookup promise: %s", (text) => {
    expect(isRealtimeCheckingBackchannel(text)).toBe(true);
  });

  it.each([
    "The charge is for the March insurance premium.",
    "I checked it. The balance is $1,000.",
    "Let me check. I found the answer: it is $1,000.",
    "Let me check the project status; I found the approved schedule.",
    "One moment: the balance is $1,000.",
    "I reviewed it. The answer is $1,000.",
    "",
  ])("does not classify a result or multi-sentence answer as a backchannel: %s", (text) => {
    expect(isRealtimeCheckingBackchannel(text)).toBe(false);
  });
});
