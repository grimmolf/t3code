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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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

const ran = { result: null, stdout: "", stderr: "", truncated: false, error: null, t3Calls: 0 };

/** A thread whose turn is running on a session no process holds. */
const startTurn = Effect.fn("startTurn")(function* (
  name: string,
  runtimeMode: RuntimeMode = "approval-required",
  runInstanceId: ProviderInstanceId = instanceId,
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
        providerInstanceId: runInstanceId,
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

/** Ends the thread's latest run, if it still runs, and starts the next one. */
const startNextRun = Effect.fn("startNextRun")(function* (threadId: ThreadId, name: string) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
  const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
  assert.ok(latest !== undefined);
  const now = yield* DateTime.now;
  if (latest.status === "running") {
    yield* projections.apply({
      id: EventId.make(`seed:${name}:ended`),
      type: "run.updated",
      threadId,
      runId: latest.id,
      occurredAt: now,
      payload: { ...latest, status: "completed", completedAt: now },
    } as OrchestrationV2DomainEvent);
  }
  yield* projections.apply({
    id: EventId.make(`seed:${name}:next`),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: {
      ...latest,
      id: RunId.make(`run:${name}`),
      ordinal: latest.ordinal + 1,
      status: "running",
      completedAt: null,
    },
  } as OrchestrationV2DomainEvent);
});

type Threads = ThreadManagementService.ThreadManagementService["Service"];

const withCodeMode = <A, E, R>(
  use: (codeMode: CodeMode.CodeMode["Service"], runs: Array<string>) => Effect.Effect<A, E, R>,
  options: {
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
    /** Wraps the thread service Code Mode sees; the test body keeps the real one. */
    readonly threads?: (threads: Threads) => Threads;
  } = {},
) => {
  const runs: Array<string> = [];
  const instance = {
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: options.supportedRuntimeModes,
      } as ServerProvider),
    },
  } as ProviderInstance;
  return Effect.flatMap(CodeMode.CodeMode, (codeMode) => use(codeMode, runs)).pipe(
    Effect.provide(
      CodeMode.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.effect(
              ThreadManagementService.ThreadManagementService,
              Effect.map(
                ThreadManagementService.ThreadManagementService,
                options.threads ?? ((t) => t),
              ),
            ),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
            }),
            Layer.mock(CodeRunner.CodeRunner)({
              start: () =>
                Effect.succeed({
                  evaluate: (input) => Effect.sync(() => (runs.push(input.code), ran)),
                  end: () => Effect.void,
                  ended: Effect.never,
                }),
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

/** The next approval card opened in the thread after `afterSequence`. */
const pendingCardAfter = Effect.fn("pendingCardAfter")(function* (
  threadId: ThreadId,
  afterSequence: number,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const pending = yield* threads
    .streamStoredEventsFrom({ threadId, afterSequence, eventType: "runtime-request.updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "runtime-request.updated" &&
          stored.event.payload.status === "pending",
      ),
      Stream.runHead,
    );
  assert.ok(Option.isSome(pending) && pending.value.event.type === "runtime-request.updated");
  return pending.value.event.payload.id as RuntimeRequestId;
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
/** Why a script did not run: the user's answer, or the refusal's tag. */
const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  if (isNotApproved(error)) return error.outcome;
  return typeof error === "object" && error !== null && "_tag" in error ? error._tag : exit;
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
      yield* startNextRun(threadId, "after-restart");
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

it.effect("asks for a script whose thread moved to Supervised after the call began", () => {
  // The first read sees Full access; every later read sees the thread's real Supervised mode.
  const shellReads = new Map<ThreadId, number>();
  const firstReadFullAccess = (threads: Threads): Threads => ({
    ...threads,
    getThreadShell: (threadId) =>
      threads.getThreadShell(threadId).pipe(
        Effect.map((shell) => {
          const reads = (shellReads.get(threadId) ?? 0) + 1;
          shellReads.set(threadId, reads);
          return reads === 1 && shell !== null
            ? { ...shell, runtimeMode: "full-access" as const }
            : shell;
        }),
      ),
  });
  return withCodeMode(
    (codeMode, runs) =>
      Effect.gen(function* () {
        const { threadId } = yield* startTurn("moved-to-supervised");
        const asked = yield* startAsking(codeMode, threadId, "return 'moved'");
        assert.deepEqual(runs, []);
        yield* respond(threadId, asked.requestId, "accept");
        yield* Fiber.join(asked.script);
        assert.deepEqual(runs, ["return 'moved'"]);
      }),
    { threads: firstReadFullAccess },
  ).pipe(Effect.provide(layerTest));
});

it.effect("times out a queued script within one deadline and leaves no card open", () =>
  withCodeMode((codeMode, runs) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { threadId } = yield* startTurn("queued-deadline");
      const waiting = yield* startAsking(codeMode, threadId, "return 'waiting'");
      const behind = yield* codeMode
        .run(threadId, "return 'behind'")
        .pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust("50 minutes");

      assert.equal(refusal(yield* Fiber.await(waiting.script)), "timed_out");
      assert.equal(refusal(yield* Fiber.join(behind)), "timed_out");
      const { runtimeRequests } = yield* threads.getThreadRecords(threadId, ["runtimeRequests"]);
      assert.deepEqual(
        runtimeRequests.filter((request) => request.status === "pending"),
        [],
      );
      assert.deepEqual(runs, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("asks for each queued script in turn", () =>
  withCodeMode((codeMode, runs) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const cards = (threadId: ThreadId) =>
        threads
          .getThreadRecords(threadId, ["runtimeRequests"])
          .pipe(Effect.map(({ runtimeRequests }) => runtimeRequests.length));

      const answered = yield* startTurn("queued-answered");
      const first = yield* startAsking(codeMode, answered.threadId, "return 'first'");
      const queued = yield* codeMode
        .run(answered.threadId, "return 'second'")
        .pipe(Effect.exit, Effect.forkChild);
      const beforeAnswer = yield* threads.getThreadEventSequence(answered.threadId);
      yield* respond(answered.threadId, first.requestId, "accept");
      yield* Fiber.join(first.script);
      const second = yield* pendingCardAfter(answered.threadId, beforeAnswer);
      assert.equal(yield* cards(answered.threadId), 2);
      yield* respond(answered.threadId, second, "accept");
      assert.ok(Exit.isSuccess(yield* Fiber.join(queued)));
      assert.deepEqual(runs, ["return 'first'", "return 'second'"]);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("asks where the running turn's provider may not run the thread's mode", () =>
  withCodeMode(
    (codeMode, runs) =>
      Effect.gen(function* () {
        const downgraded = yield* startTurn("downgraded", "auto");
        const asked = yield* startAsking(codeMode, downgraded.threadId, "return 'asked'");
        yield* respond(downgraded.threadId, asked.requestId, "accept");
        yield* Fiber.join(asked.script);

        const unknown = ProviderInstanceId.make("unknown");
        const unread = yield* startTurn("unread", "full-access", unknown);
        const unreadAsked = yield* startAsking(codeMode, unread.threadId, "return 'unread'");
        yield* respond(unread.threadId, unreadAsked.requestId, "accept");
        yield* Fiber.join(unreadAsked.script);
        assert.deepEqual(runs, ["return 'asked'", "return 'unread'"]);
      }),
    { supportedRuntimeModes: ["approval-required", "full-access"] },
  ).pipe(Effect.provide(layerTest)),
);

it.effect("runs nothing when the user declines, the call is cancelled, or the turn stops", () =>
  Effect.gen(function* () {
    // Holds the next card's open after it commits, so the call can be cancelled right there.
    const opening = {
      armed: false,
      requestId: undefined as RuntimeRequestId | undefined,
      committed: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    const threadsHeldAtOpen = (threads: Threads): Threads => ({
      ...threads,
      dispatch: (command) =>
        command.type === "runtime-request.open" && opening.armed
          ? threads.dispatch(command).pipe(
              Effect.tap(() => {
                opening.armed = false;
                opening.requestId = command.requestId;
                return Deferred.succeed(opening.committed, undefined).pipe(
                  Effect.andThen(Deferred.await(opening.release)),
                );
              }),
            )
          : threads.dispatch(command),
    });
    yield* withCodeMode(
      (codeMode, runs) =>
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const settings = yield* ServerSettings.ServerSettingsService;
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
          assert.equal(refusal(yield* Fiber.await(declined.script)), "declined");

          const cancelled = yield* startAsking(codeMode, threadId, "return 'cancelled'");
          yield* Fiber.interrupt(cancelled.script);
          assert.deepEqual(yield* statusOf(cancelled.requestId), ["resolved", "cancelled"]);

          opening.armed = true;
          const cancelledAtOpen = yield* codeMode
            .run(threadId, "return 'cancelled at open'")
            .pipe(Effect.forkChild);
          yield* Deferred.await(opening.committed);
          yield* Fiber.interrupt(cancelledAtOpen).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(opening.release, undefined);
          yield* Fiber.await(cancelledAtOpen);
          assert.deepEqual(yield* statusOf(opening.requestId!), ["resolved", "cancelled"]);

          const planned = yield* startAsking(codeMode, threadId, "return 'planned'");
          yield* threads.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("plan:refuse"),
            threadId,
            interactionMode: "plan",
          });
          yield* respond(threadId, planned.requestId, "accept");
          assert.equal(refusal(yield* Fiber.await(planned.script)), "CodeModeRefusedError");
          yield* threads.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("default:refuse"),
            threadId,
            interactionMode: "default",
          });

          const turnedOff = yield* startAsking(codeMode, threadId, "return 'turned off'");
          yield* settings.updateSettings({ codeModeEnabled: false });
          yield* respond(threadId, turnedOff.requestId, "accept");
          assert.equal(refusal(yield* Fiber.await(turnedOff.script)), "CodeModeOffError");
          yield* settings.updateSettings({ codeModeEnabled: true });

          // The calling turn ends and another starts while its card stays open.
          const ended = yield* startTurn("ended");
          const orphaned = yield* startAsking(codeMode, ended.threadId, "return 'orphaned'");
          yield* startNextRun(ended.threadId, "ended-next");
          yield* respond(ended.threadId, orphaned.requestId, "accept");
          assert.equal(refusal(yield* Fiber.await(orphaned.script)), "CodeModeTurnEndedError");

          const stopped = yield* startAsking(codeMode, threadId, "return 'stopped'");
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("interrupt:refuse"),
            threadId,
            runId,
          });
          assert.equal(refusal(yield* Fiber.await(stopped.script)), "closed");
          assert.deepEqual(yield* statusOf(stopped.requestId), ["cancelled", "interrupted"]);
          assert.deepEqual(runs, []);
        }),
      { threads: threadsHeldAtOpen },
    );
  }).pipe(Effect.provide(layerTest)),
);
