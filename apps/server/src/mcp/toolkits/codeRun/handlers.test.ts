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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CodeMode from "../../../codeMode/CodeMode.ts";
import * as CodeRunner from "../../../codeMode/CodeRunner.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CodeRunHandlers from "./handlers.ts";
import { CodeRunToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:code-run");
const environment = { PATH: "/usr/bin", HOME: "/home/user" };
const ran = { result: 12, stdout: "", stderr: "", truncated: false, error: null };

const call = Effect.fn("call")(function* (caller: {
  readonly codeModeEnabled?: boolean;
  readonly client?: boolean;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}) {
  const runs: Array<CodeRunner.CodeRunInput> = [];
  const shell = { ...liveThreadShell(threadId, caller), projectId: ProjectId.make("project:acme") };
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:code-run"),
      requestNamespace: "provider:code-run",
      thread:
        caller.client === true
          ? undefined
          : {
              threadId,
              providerSessionId: "provider:code-run",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
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
        ServerSettings.layerTest({ codeModeEnabled: caller.codeModeEnabled ?? true }),
        Layer.succeed(HostProcess.Environment, environment),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.undefined,
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

it.effect("runs a thread's script in its workspace with the server's environment", () =>
  Effect.gen(function* () {
    for (const runtimeMode of ["full-access", "auto"] as const) {
      const { result, runs } = yield* call({ runtimeMode });
      expect(result).toEqual(ran);
      expect(runs).toEqual([{ code: "return 12", cwd: "/home/user/acme", environment }]);
    }
  }),
);

it.effect("refuses every caller Code Mode is not for, before anything runs", () =>
  Effect.gen(function* () {
    const refusals = [
      [{ client: true }, "thread_credential_required"],
      [{ codeModeEnabled: false }, "capability_denied"],
      [{ interactionMode: "plan" }, "interaction_mode_escalation_denied"],
    ] as const;
    for (const [caller, code] of refusals) {
      const { result, runs } = yield* call(caller);
      expect(result).toMatchObject({ code });
      expect(runs).toEqual([]);
    }
  }),
);
