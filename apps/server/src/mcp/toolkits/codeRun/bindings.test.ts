import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as CodeRunBindings from "./bindings.ts";

const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment:code-run"),
  requestNamespace: "provider:code-run",
  thread: {
    threadId: ThreadId.make("thread:code-run"),
    providerSessionId: "provider:code-run",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

// The handlers' own services; the calls below stop before reaching any but ProjectService.
const layer = McpHttpServer.layerCodeRunBindings.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpToolAccessTestkit.liveThreadsLayer,
      Layer.mock(ProjectService.ProjectService)({
        listPage: () => Effect.succeed({ projects: [], nextCursor: null }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(McpProviderSessions.McpProviderSessions)({}),
      Layer.mock(PreviewBrowser.PreviewBrowser)({}),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadSearch.ThreadSearch)({}),
      ServerSettings.layerTest(),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-code-run-bindings-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeCrypto.layer,
      NodeServices.layer,
    ),
  ),
);

it.effect("calls the allowed T3 tools as a direct call would, and refuses the rest", () =>
  Effect.gen(function* () {
    const bindings = yield* CodeRunBindings.CodeRunBindings;
    const refusal = (
      tool: string,
      args: Schema.Json,
      caller: McpInvocationContext.McpThreadInvocationScope = scope,
    ) =>
      bindings.call(caller, tool, args).pipe(
        Effect.flip,
        Effect.map(({ reason, code }) => ({ reason, code })),
      );

    expect(bindings.tools).toEqual([
      "t3_thread_list",
      "t3_thread_read",
      "t3_thread_search",
      "t3_thread_send",
      "delegate_task",
      "task_status",
      "t3_project_list",
      "t3_project_read",
      "orchestrator_capabilities",
      "html_render",
    ]);
    expect(yield* bindings.call(scope, "t3_project_list", { limit: null })).toEqual({
      projects: [],
      nextCursor: null,
    });
    expect(yield* refusal("t3_project_list", { bogus: 1 })).toEqual({
      reason:
        "Invalid parameters for tool 't3_project_list': Unknown argument \"bogus\". Accepted arguments: environmentId, cursor, limit.",
      code: undefined,
    });
    expect(yield* refusal("t3_project_list", { limit: "many" })).toEqual({
      reason:
        "Invalid parameters for tool 't3_project_list': Expected number | null\n  at [\"limit\"]",
      code: undefined,
    });
    expect(yield* refusal("t3_project_list", {}, { ...scope, capabilities: new Set() })).toEqual({
      reason: "This credential cannot control threads.",
      code: "capability_denied",
    });
    expect(yield* refusal("t3_thread_wait", { threadId: "thread:other" })).toEqual({
      reason: "t3.t3_thread_wait is not available to scripts.",
      code: undefined,
    });
    expect(yield* refusal("delegate_task", { task: "Fix the build", mode: "wait" })).toEqual({
      reason:
        'A script cannot wait on a child: call t3.delegate_task with mode "async", then t3.task_status.',
      code: undefined,
    });
  }).pipe(Effect.provide(layer)),
);
