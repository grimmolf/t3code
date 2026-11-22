import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

/** What a `t3_code_run` call does in a thread: run, ask the user (until they allow the thread), or refuse. */
export type CodeModeDecision = "run" | "ask" | "refuse";

const DECISIONS = {
  "full-access": "run",
  auto: "run",
  "auto-accept-edits": "ask",
  "approval-required": "ask",
  plan: "refuse",
} as const satisfies Record<RuntimeMode | "plan", CodeModeDecision>;

export const codeModeDecision = (thread: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): CodeModeDecision => DECISIONS[thread.interactionMode === "plan" ? "plan" : thread.runtimeMode];
