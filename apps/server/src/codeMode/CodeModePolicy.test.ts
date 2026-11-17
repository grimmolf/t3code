import { expect, it } from "@effect/vitest";

import { codeModeDecision } from "./CodeModePolicy.ts";

it("runs, asks or refuses a script by the thread's mode", () => {
  const rows = [
    ["full-access", "default", "run"],
    ["auto", "default", "run"],
    ["auto-accept-edits", "default", "ask"],
    ["approval-required", "default", "ask"],
    ["full-access", "plan", "refuse"],
    ["approval-required", "plan", "refuse"],
  ] as const;
  for (const [runtimeMode, interactionMode, decision] of rows) {
    expect(codeModeDecision({ runtimeMode, interactionMode }), runtimeMode).toBe(decision);
  }
});
