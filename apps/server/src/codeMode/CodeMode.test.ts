import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecoveryService from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodeMode from "./CodeMode.ts";
import * as CodeRunner from "./CodeRunner.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "code-mode" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest({ codeModeEnabled: true })),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const ran = { result: null, stdout: "", stderr: "", truncated: false, error: null };

/** A thread whose turn is running on a session no process holds. */
const startTurn = Effect.fn("startTurn")(function* (
  name: string,
  runtimeMode: RuntimeMode = "approval-required",
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  const sessionId = ProviderSessionId.make(`session:${name}`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
  const runId = RunId.make(`run:${name}`);
  const rootNodeId = NodeId.make(`node:${name}`);
  const attemptId = RunAttemptId.make(`attempt:${name}`);
  const now = yield* DateTime.now;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: "/repo",
    createdBy: "user",
    creationSource: "web",
  });
  const events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> = [
    {
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    },
    {
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:${name}`),
        rootNodeId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      type: "run-attempt.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: ProviderTurnId.make(`provider-turn:${name}`),
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      type: "node.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: true,
        providerThreadId,
        providerTurnId: ProviderTurnId.make(`provider-turn:${name}`),
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    },
    {
      type: "provider-turn.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make(`provider-turn:${name}`),
        providerThreadId,
        nodeId: rootNodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: `native-turn:${name}`, strength: "strong" },
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
  ];
  for (const [index, event] of events.entries()) {
    yield* projections.apply({
      ...event,
      id: EventId.make(`seed:${name}:${index}`),
    } as OrchestrationV2DomainEvent);
  }
  return { threadId, runId };
});

const withCodeMode = <A, E, R>(
  use: (codeMode: CodeMode.CodeMode["Service"], runs: Array<string>) => Effect.Effect<A, E, R>,
  supportedRuntimeModes?: ReadonlyArray<RuntimeMode>,
) => {
  const runs: Array<string> = [];
  const instance = {
    snapshot: { getSnapshot: Effect.succeed({ supportedRuntimeModes } as ServerProvider) },
  } as ProviderInstance;
  return Effect.flatMap(CodeMode.CodeMode, (codeMode) => use(codeMode, runs)).pipe(
    Effect.provide(
      CodeMode.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(instance),
            }),
            Layer.mock(CodeRunner.CodeRunner)({
              run: (input) => Effect.sync(() => (runs.push(input.code), ran)),
            }),
          ),
        ),
      ),
    ),
  );
};

/** Starts a script and returns it once its approval card is pending. */
const startAsking = Effect.fn("startAsking")(function* (
  codeMode: CodeMode.CodeMode["Service"],
  threadId: ThreadId,
  code: string,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const afterSequence = yield* threads.getThreadEventSequence(threadId);
  const script = yield* codeMode.run(threadId, code).pipe(Effect.forkChild);
  const pending = yield* threads
    .streamStoredEventsFrom({ threadId, afterSequence, eventType: "runtime-request.updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "runtime-request.updated" &&
          stored.event.payload.status === "pending",
      ),
      Stream.runHead,
      Effect.raceFirst(Fiber.await(script).pipe(Effect.as(Option.none()))),
    );
  assert.ok(Option.isSome(pending), "the script finished without asking");
  assert.ok(pending.value.event.type === "runtime-request.updated");
  const requestId = pending.value.event.payload.id as RuntimeRequestId;
  return { script, requestId };
});

const respond = (
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  decision: "accept" | "acceptForSession" | "decline",
) =>
  Effect.flatMap(ThreadManagementService.ThreadManagementService, (threads) =>
    threads.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`respond:${requestId}`),
      threadId,
      requestId,
      decision,
    }),
  );

const isNotApproved = Schema.is(CodeMode.CodeModeNotApprovedError);
const notApproved = (exit: Exit.Exit<unknown, unknown>) => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  return isNotApproved(error) ? error.outcome : exit;
};

it.effect("asks for each script until the user allows the thread", () =>
  withCodeMode((codeMode, runs) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { threadId } = yield* startTurn("allow");

      const once = yield* startAsking(codeMode, threadId, "return 'once'");
      const card = yield* threads.getThreadRecords(threadId, ["turnItems"], {
        turnItemRequestIds: [once.requestId],
      });
      const item = card.turnItems[0];
      assert.equal(item?.type, "approval_request");
      if (item?.type === "approval_request") {
        assert.equal(item.status, "waiting");
        assert.equal(item.prompt, "return 'once'");
        assert.deepEqual(item.options, CodeMode.CODE_RUN_APPROVAL_OPTIONS);
      }
      assert.deepEqual(runs, []);
      yield* respond(threadId, once.requestId, "accept");
      yield* Fiber.join(once.script);
      assert.deepEqual(runs, ["return 'once'"]);

      const allow = yield* startAsking(codeMode, threadId, "return 'allow'");
      yield* respond(threadId, allow.requestId, "acceptForSession");
      yield* Fiber.join(allow.script);

      // No provider holds these requests, so delivering the answers must not reach one.
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      for (const requestId of [once.requestId, allow.requestId]) {
        const delivered = yield* outbox.listByCommandId(CommandId.make(`respond:${requestId}`));
        assert.deepEqual(
          delivered.map((effect) => [effect.request.type, effect.status]),
          [["runtime-request.respond", "succeeded"]],
        );
      }

      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      yield* recovery.reconcile("shutdown");
      yield* recovery.reconcile("startup");
      yield* codeMode.run(threadId, "return 'unasked'");
      assert.deepEqual(runs, ["return 'once'", "return 'allow'", "return 'unasked'"]);
      const requests = yield* threads.getThreadRecords(threadId, ["runtimeRequests"]);
      assert.deepEqual(requests.runtimeRequests.map((request) => request.decision).toSorted(), [
        "accept",
        "acceptForSession",
      ]);
    }),
  ).pipe(
    Effect.provide(
      ProviderRuntimeRecoveryService.layer.pipe(
        Layer.provide(IdAllocator.layer),
        Layer.provideMerge(layerTest),
      ),
    ),
  ),
);

it.effect("asks in an Auto thread whose provider runs Auto as Supervised", () =>
  withCodeMode(
    (codeMode, runs) =>
      Effect.gen(function* () {
        const { threadId } = yield* startTurn("downgraded", "auto");
        const asked = yield* startAsking(codeMode, threadId, "return 'asked'");
        yield* respond(threadId, asked.requestId, "accept");
        yield* Fiber.join(asked.script);
        assert.deepEqual(runs, ["return 'asked'"]);
      }),
    ["approval-required", "full-access"],
  ).pipe(Effect.provide(layerTest)),
);

it.effect("runs nothing when the user declines, the call is cancelled, or the turn stops", () =>
  withCodeMode((codeMode, runs) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { threadId, runId } = yield* startTurn("refuse");
      const statusOf = (requestId: RuntimeRequestId) =>
        threads
          .getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
            turnItemRequestIds: [requestId],
          })
          .pipe(
            Effect.map((records) => [
              records.runtimeRequests.find((request) => request.id === requestId)?.status,
              records.turnItems[0]?.status,
            ]),
          );

      const declined = yield* startAsking(codeMode, threadId, "return 'declined'");
      yield* respond(threadId, declined.requestId, "decline");
      assert.equal(notApproved(yield* Fiber.await(declined.script)), "declined");

      const cancelled = yield* startAsking(codeMode, threadId, "return 'cancelled'");
      yield* Fiber.interrupt(cancelled.script);
      assert.deepEqual(yield* statusOf(cancelled.requestId), ["resolved", "cancelled"]);

      const stopped = yield* startAsking(codeMode, threadId, "return 'stopped'");
      yield* threads.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt:refuse"),
        threadId,
        runId,
      });
      assert.equal(notApproved(yield* Fiber.await(stopped.script)), "closed");
      assert.deepEqual(yield* statusOf(stopped.requestId), ["cancelled", "interrupted"]);
      assert.deepEqual(runs, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);
