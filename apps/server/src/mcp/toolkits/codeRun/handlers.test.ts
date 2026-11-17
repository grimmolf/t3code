import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2Run,
  type Project,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
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
import * as McpSessionRegistryTestkit from "../../McpSessionRegistry.testkit.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CodeRunBindings from "./bindings.ts";
import * as CodeRunHandlers from "./handlers.ts";
import { CodeRunToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:code-run");
const environment = { PATH: "/usr/bin", HOME: "/home/user" };
const ran = { result: 12, stdout: "", stderr: "", truncated: false, error: null, t3Calls: 0 };

const codex = ProviderInstanceId.make("codex");
const running = {
  id: RunId.make("run:code-run"),
  ordinal: 1,
  providerInstanceId: codex,
  status: "running",
} as OrchestrationV2Run;
const instance = {
  snapshot: { getSnapshot: Effect.succeed({} as ServerProvider) },
} as ProviderInstance;

const call = Effect.fn("call")(function* (caller: {
  readonly codeModeEnabled?: boolean;
  readonly client?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly code?: string;
}) {
  const runs: Array<
    CodeRunner.CodeSessionInput & { readonly code: string; readonly tools: ReadonlyArray<string> }
  > = [];
  const bound: Array<[string | undefined, string]> = [];
  const shell = { ...liveThreadShell(threadId), projectId: ProjectId.make("project:acme") };
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
              providerInstanceId: codex,
            },
      client:
        caller.client === true
          ? { sessionId: "oauth:code-run", label: "Outside client", access: "full-access" }
          : undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(CodeRunBindings.CodeRunBindings)({
      tools: ["t3_thread_list"],
      call: (scope, tool) =>
        Effect.sync(() => (bound.push([scope.thread.providerSessionId, tool]), null)),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      subscribeStoredEvents: Effect.succeed(Stream.never),
      getThreadEventSequence: () => Effect.succeed(0),
      getThreadShell: () => Effect.succeed(shell),
      getThreadRecords: (() =>
        Effect.succeed({
          runs: [running],
        })) as unknown as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
    }),
  );
  const layerCodeMode = CodeMode.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        // The test layer's changes end at once, which Code Mode reads as lost, so it refuses runs.
        Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.map(ServerSettings.ServerSettingsService, (settings) => ({
            ...settings,
            subscribeChanges: Effect.succeed(Stream.never),
          })),
        ).pipe(
          Layer.provide(
            ServerSettings.layerTest({ codeModeEnabled: caller.codeModeEnabled ?? true }),
          ),
        ),
        Layer.succeed(HostProcess.Environment, environment),
        McpSessionRegistryTestkit.layer,
        Layer.succeed(HostProcess.Platform, caller.platform ?? "linux"),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(instance),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: "/home/user/acme" } as Project),
        }),
        Layer.mock(CodeRunner.CodeRunner)({
          start: (input) =>
            Effect.succeed({
              evaluate: ({ code, tools, call }) =>
                call("t3_thread_list", {}).pipe(
                  Effect.orDie,
                  Effect.as((runs.push({ ...input, code, tools }), ran)),
                ),
              end: () => Effect.void,
              ended: Effect.never,
              hasEnded: Effect.succeed(false),
            }),
        }),
      ),
    ),
  );
  const result = yield* Effect.gen(function* () {
    const toolkit = yield* CodeRunToolkit;
    return yield* toolkit.handle("t3_code_run", { code: caller.code ?? "return 12" }).pipe(
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
  return { result, runs, bound };
});

it.effect("runs a thread's script in its workspace with the server's environment", () =>
  Effect.gen(function* () {
    const { result, runs, bound } = yield* call({});
    expect(result).toEqual({
      handle: expect.any(String),
      status: "done",
      ...ran,
      sessionStarted: true,
    });
    expect(runs).toEqual([
      { code: "return 12", cwd: "/home/user/acme", environment, tools: ["t3_thread_list"] },
    ]);
    expect(bound).toEqual([["provider:code-run", "t3_thread_list"]]);
  }),
);

it.effect("refuses every caller Code Mode is not for, before anything runs", () =>
  Effect.gen(function* () {
    const refusals = [
      [{ client: true }, { code: "thread_credential_required" }],
      [{ codeModeEnabled: false }, { code: "capability_denied" }],
      [{ platform: "win32" }, { code: "capability_denied" }],
      // Under 65,536 characters, but 80,000 bytes of UTF-8.
      [{ code: "é".repeat(40_000) }, { reason: { _tag: "ToolParameterValidationError" } }],
    ] as const;
    for (const [caller, refusal] of refusals) {
      const { result, runs } = yield* call(caller);
      expect(result).toMatchObject(refusal);
      expect(runs).toEqual([]);
    }
  }),
);
