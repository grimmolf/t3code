import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Project,
  ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CodeMode from "../../../codeMode/CodeMode.ts";
import * as CodeRunner from "../../../codeMode/CodeRunner.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CodeRunHandlers from "./handlers.ts";
import { CodeRunToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:code-run");
const claudeOn = ProviderInstanceId.make("claudeAgent");
const claudeOff = ProviderInstanceId.make("claude_work");
const codex = ProviderInstanceId.make("codex");
const environment = { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://claude.example" };
const ran = { result: 12, stdout: "", stderr: "", truncated: false, error: null };

const call = Effect.fn("call")(function* (caller: {
  readonly providerInstanceId?: ProviderInstanceId;
  readonly client?: boolean;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}) {
  const runs: Array<CodeRunner.CodeRunInput> = [];
  const providerInstanceId = caller.providerInstanceId ?? claudeOn;
  const shell = {
    ...liveThreadShell(threadId, caller),
    projectId: ProjectId.make("project:acme"),
    providerInstanceId,
  };
  const instances = new Map<ProviderInstanceId, Partial<ProviderInstance>>([
    [claudeOn, { codeRun: { environment } }],
    [claudeOff, {}],
    [codex, {}],
  ]);
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:code-run"),
      requestNamespace: "provider:code-run",
      thread:
        caller.client === true
          ? undefined
          : { threadId, providerSessionId: "provider:code-run", providerInstanceId },
      client:
        caller.client === true
          ? { sessionId: "oauth:code-run", label: "Outside client", access: "full-access" }
          : undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell),
    }),
  );
  const layerCodeMode = CodeMode.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) => Effect.succeed(instances.get(id) as ProviderInstance | undefined),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: "/home/user/acme" } as Project),
        }),
        Layer.mock(CodeRunner.CodeRunner)({
          run: (input) => Effect.sync(() => (runs.push(input), ran)),
        }),
      ),
    ),
  );
  const result = yield* Effect.gen(function* () {
    const toolkit = yield* CodeRunToolkit;
    return yield* toolkit.handle("t3_code_run", { code: "return 12" }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(CodeRunHandlers.layer).pipe(
        Layer.provideMerge(Layer.merge(layerDependencies, layerCodeMode)),
      ),
    ),
  );
  return { result, runs };
});

it.effect("runs a Claude thread's script in its workspace with the instance's environment", () =>
  Effect.gen(function* () {
    const { result, runs } = yield* call({});
    expect(result).toEqual(ran);
    expect(runs).toEqual([{ code: "return 12", cwd: "/home/user/acme", environment }]);
  }),
);

it.effect("refuses every caller Code Mode is not for, before anything runs", () =>
  Effect.gen(function* () {
    const refusals = [
      [{ client: true }, "thread_credential_required"],
      [{ providerInstanceId: codex }, "capability_denied"],
      [{ providerInstanceId: claudeOff }, "capability_denied"],
      [{ interactionMode: "plan" }, "interaction_mode_escalation_denied"],
    ] as const;
    for (const [caller, code] of refusals) {
      const { result, runs } = yield* call(caller);
      expect(result).toMatchObject({ code });
      expect(runs).toEqual([]);
    }
  }),
);
