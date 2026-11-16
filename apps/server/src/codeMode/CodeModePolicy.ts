import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

/** What a `t3_code_run` call does in a thread: run unasked, ask the user first, or refuse. */
type CodeModeDecision = "run" | "ask" | "refuse";

// Under `auto`, Claude hands an ask-ruled call to the host rather than its classifier, and the
// classifier would only see the code, never what it computes; so the user decides.
const DECISIONS = {
  "full-access": "run",
  auto: "ask",
  "auto-accept-edits": "ask",
  "approval-required": "ask",
  plan: "refuse",
  "read-only": "refuse",
} as const satisfies Record<RuntimeMode | "plan" | "read-only", CodeModeDecision>;

export const codeModeDecision = (modes: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly readOnlySandbox?: boolean;
}): CodeModeDecision =>
  DECISIONS[
    modes.readOnlySandbox === true
      ? "read-only"
      : modes.interactionMode === "plan"
        ? "plan"
        : modes.runtimeMode
  ];
