import * as NodeServices from "@effect/platform-node/NodeServices";
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
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Cause from "effect/Cause";
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
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
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
/** A script the recorded runner never finishes. */
const HOLD = "await new Promise(() => {});";

/** A thread whose turn is running on a session no process holds. */
const startTurn = Effect.fn("startTurn")(function* (
  name: string,
  runtimeMode: RuntimeMode = "approval-required",
  runInstanceId: ProviderInstanceId = instanceId,
  worktreePath = "/repo",
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
    worktreePath,
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

const credential = "credential:code-mode";
const noBindings: CodeMode.CodeModeBindings = {
  tools: [],
  call: () => Effect.die("This script makes no t3 calls."),
};
const runScript = (
  codeMode: CodeMode.CodeMode["Service"],
  threadId: ThreadId,
  code: string,
  options: {
    readonly bindings?: CodeMode.CodeModeBindings;
    readonly providerSessionId?: string;
  } = {},
) =>
  codeMode.run({
    threadId,
    providerSessionId: options.providerSessionId ?? credential,
    code,
    bindings: options.bindings ?? noBindings,
  });

/** A `t3.hold()` that never returns, until the session it was called from is torn down. */
const holding = Effect.fn("holding")(function* () {
  const called = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const bindings: CodeMode.CodeModeBindings = {
    tools: ["hold"],
    call: () =>
      Deferred.succeed(called, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
  };
  return { bindings, called: Deferred.await(called), stopped: Deferred.await(stopped) };
});

const workspace = Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
  fileSystem.makeTempDirectoryScoped({ prefix: "t3code-code-mode-" }),
).pipe(Effect.provide(NodeServices.layer));

const withCodeMode = <A, E, R>(
  use: (codeMode: CodeMode.CodeMode["Service"], runs: Array<string>) => Effect.Effect<A, E, R>,
  options: {
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
    /** Wraps the thread service Code Mode sees; the test body keeps the real one. */
    readonly threads?: (threads: Threads) => Threads;
    /** Runs scripts in real Node sessions instead of recording them. */
    readonly realRunner?: boolean;
    readonly revocations?: Queue.Queue<McpInvocationContext.McpThreadCaller>;
    /** Credentials the registry no longer holds. */
    readonly revoked?: ReadonlySet<string>;
    /** Each recorded session's process starts once this succeeds. */
    readonly starting?: Effect.Effect<void>;
    readonly settingChanges?: Queue.Queue<ServerSettingsValue, Cause.Done>;
    /** Why each recorded session was ended. */
    readonly ended?: Array<string>;
    /** Receives the same reasons, for a test to wait on. */
    readonly endings?: Queue.Queue<string>;
    /** Set to make every recorded session's process report that it exited. */
    readonly exited?: { reason: string | undefined };
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
            options.realRunner === true
              ? CodeRunner.layer.pipe(Layer.provide(NodeServices.layer))
              : Layer.mock(CodeRunner.CodeRunner)({
                  start: () =>
                    Effect.as(options.starting ?? Effect.void, {
                      evaluate: (input) =>
                        input.code === HOLD
                          ? Effect.never
                          : Effect.sync(() => (runs.push(input.code), ran)),
                      end: (reason) =>
                        Effect.sync(() => options.ended?.push(reason)).pipe(
                          Effect.andThen(
                            options.endings === undefined
                              ? Effect.void
                              : Queue.offer(options.endings, reason),
                          ),
                          Effect.asVoid,
                        ),
                      ended: Effect.suspend(() =>
                        options.exited?.reason === undefined
                          ? Effect.never
                          : Effect.succeed(options.exited.reason),
                      ),
                      hasEnded: Effect.sync(() => options.exited?.reason !== undefined),
                    }),
                }),
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              subscribeRevocations: Effect.succeed(
                options.revocations === undefined
                  ? Stream.never
                  : Stream.fromQueue(options.revocations),
              ),
              isIssued: (providerSessionId) =>
                Effect.succeed(options.revoked?.has(providerSessionId) !== true),
            }),
            Layer.effect(
              ServerSettings.ServerSettingsService,
              Effect.map(ServerSettings.ServerSettingsService, (settings) => ({
                ...settings,
                // The test layer's stream ends at once, which Code Mode reads as lost changes.
                subscribeChanges: Effect.succeed(
                  options.settingChanges === undefined
                    ? Stream.never
                    : Stream.fromQueue(options.settingChanges),
                ),
              })),
            ),
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
  const script = yield* runScript(codeMode, threadId, code).pipe(Effect.forkChild);
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
      yield* runScript(codeMode, threadId, "return 'unasked'");
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
      const behind = yield* runScript(codeMode, threadId, "return 'behind'").pipe(
        Effect.exit,
        Effect.forkChild,
      );

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
      const queued = yield* runScript(codeMode, answered.threadId, "return 'second'").pipe(
        Effect.exit,
        Effect.forkChild,
      );
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
          const cancelledAtOpen = yield* runScript(
            codeMode,
            threadId,
            "return 'cancelled at open'",
          ).pipe(Effect.forkChild);
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

/** What a result says about its session, beside its output. */
const sessionOf = (result: CodeMode.CodeRunResult) => ({
  status: result.status,
  result: result.result,
  sessionStarted: result.sessionStarted,
  notice: result.notice,
});

it.effect("returns a handle after 20 seconds, polls it, and refuses a second run meanwhile", () =>
  withCodeMode(
    (codeMode) =>
      Effect.gen(function* () {
        const { threadId } = yield* startTurn(
          "background",
          "full-access",
          instanceId,
          yield* workspace,
        );
        const called = yield* Deferred.make<void>();
        const release = yield* Deferred.make<string>();
        const bindings: CodeMode.CodeModeBindings = {
          tools: ["hold"],
          call: () =>
            Deferred.succeed(called, undefined).pipe(Effect.andThen(Deferred.await(release))),
        };
        const first = yield* runScript(
          codeMode,
          threadId,
          "globalThis.kept = 1; return await t3.hold();",
          { bindings },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(called);
        yield* TestClock.adjust(CodeMode.YIELD_AFTER);
        const started = yield* Fiber.join(first);
        assert.deepEqual(sessionOf(started), {
          status: "running",
          result: undefined,
          sessionStarted: true,
          notice: undefined,
        });

        const busy = yield* runScript(codeMode, threadId, "return 2").pipe(Effect.flip);
        assert.equal(
          busy.message,
          `${started.handle} is still running: poll it or call t3_code_reset.`,
        );

        const polled = yield* codeMode
          .poll({
            threadId,
            providerSessionId: credential,
            handle: started.handle,
            wait: Duration.minutes(1),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, "released");
        assert.deepEqual(sessionOf(yield* Fiber.join(polled)), {
          status: "done",
          result: "released",
          sessionStarted: true,
          notice: undefined,
        });
        assert.deepEqual(sessionOf(yield* runScript(codeMode, threadId, "return kept")), {
          status: "done",
          result: 1,
          sessionStarted: undefined,
          notice: undefined,
        });
      }),
    { realRunner: true },
  ).pipe(Effect.provide(layerTest)),
);

it.effect("starts a new session after a reset, a timeout or a cancelled call, and says why", () =>
  withCodeMode(
    (codeMode) =>
      Effect.gen(function* () {
        const { threadId } = yield* startTurn(
          "restarts",
          "full-access",
          instanceId,
          yield* workspace,
        );
        const kept = "return typeof globalThis.kept;";
        const keep = "globalThis.kept = 1;";

        yield* runScript(codeMode, threadId, keep);
        assert.equal((yield* runScript(codeMode, threadId, kept)).result, "number");
        assert.deepEqual(yield* codeMode.reset({ threadId, providerSessionId: credential }), {
          ended: true,
        });
        assert.deepEqual(sessionOf(yield* runScript(codeMode, threadId, kept)), {
          status: "done",
          result: "undefined",
          sessionStarted: true,
          notice: "t3_code_reset ended the previous session.",
        });

        yield* runScript(codeMode, threadId, keep);
        const timedOut = yield* holding();
        const long = yield* runScript(
          codeMode,
          threadId,
          "console.log('before'); await t3.hold();",
          {
            bindings: timedOut.bindings,
          },
        ).pipe(Effect.forkChild);
        yield* timedOut.called;
        yield* TestClock.adjust(CodeMode.YIELD_AFTER);
        const handle = (yield* Fiber.join(long)).handle;
        // Exactly to the timeout: any further and the pipes' grace would end first.
        yield* TestClock.adjust(Duration.subtract(CodeRunner.RUN_TIMEOUT, CodeMode.YIELD_AFTER));
        yield* timedOut.stopped;
        const timeout = "The script ran longer than 10 minutes and was stopped.";
        const polled = yield* codeMode.poll({
          threadId,
          providerSessionId: credential,
          handle,
          wait: CodeMode.YIELD_AFTER,
        });
        assert.deepEqual(
          [polled.status, polled.stdout, polled.error, polled.notice],
          ["done", "before\n", timeout, timeout],
        );
        assert.deepEqual(sessionOf(yield* runScript(codeMode, threadId, kept)), {
          status: "done",
          result: "undefined",
          sessionStarted: true,
          notice: timeout,
        });
        const gone = yield* codeMode
          .poll({ threadId, providerSessionId: credential, handle, wait: Duration.zero })
          .pipe(Effect.flip);
        assert.equal(
          gone.message,
          `Evaluation ${handle} is gone: a later t3_code_run replaced it.`,
        );

        yield* runScript(codeMode, threadId, keep);
        const dropped = yield* holding();
        const cancelled = yield* runScript(codeMode, threadId, "await t3.hold();", {
          bindings: dropped.bindings,
        }).pipe(Effect.forkChild);
        yield* dropped.called;
        yield* Fiber.interrupt(cancelled);
        yield* dropped.stopped;
        const afterCancel = yield* runScript(codeMode, threadId, kept);
        assert.equal(afterCancel.result, "undefined");
        assert.equal(afterCancel.sessionStarted, true);
        assert.match(
          afterCancel.notice ?? "",
          /^The t3_code_run call that started .+ was cancelled/,
        );
      }),
    { realRunner: true },
  ).pipe(Effect.provide(layerTest)),
);

it.effect("starts a new session for a new or revoked credential", () =>
  Effect.gen(function* () {
    const revocations = yield* Queue.unbounded<McpInvocationContext.McpThreadCaller>();
    yield* withCodeMode(
      (codeMode) =>
        Effect.gen(function* () {
          const { threadId } = yield* startTurn(
            "credentials",
            "full-access",
            instanceId,
            yield* workspace,
          );
          const kept = "return typeof globalThis.kept;";

          yield* runScript(codeMode, threadId, "globalThis.kept = 1;");
          assert.deepEqual(
            sessionOf(
              yield* runScript(codeMode, threadId, kept, { providerSessionId: "credential:next" }),
            ),
            {
              status: "done",
              result: "undefined",
              sessionStarted: true,
              notice:
                "A new provider session took over this thread, so its previous session ended.",
            },
          );

          const held = yield* holding();
          yield* runScript(codeMode, threadId, "globalThis.kept = 1; await t3.hold();", {
            bindings: held.bindings,
            providerSessionId: "credential:next",
          }).pipe(Effect.forkChild);
          yield* held.called;
          yield* Queue.offer(revocations, {
            threadId,
            providerSessionId: "credential:other",
            providerInstanceId: instanceId,
          });
          yield* Queue.offer(revocations, {
            threadId,
            providerSessionId: "credential:next",
            providerInstanceId: instanceId,
          });
          yield* held.stopped;
          assert.deepEqual(sessionOf(yield* runScript(codeMode, threadId, kept)), {
            status: "done",
            result: "undefined",
            sessionStarted: true,
            notice: "The provider session that started the previous session ended.",
          });
        }),
      { realRunner: true, revocations },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a script whose credential ends while it waits for approval or a session", () =>
  Effect.gen(function* () {
    const ended: Array<string> = [];
    const revoked = new Set<string>();
    const revocations = yield* Queue.unbounded<McpInvocationContext.McpThreadCaller>();
    const startBegan = yield* Deferred.make<void>();
    const startGate = yield* Deferred.make<void>();
    let starting: Effect.Effect<void> = Effect.void;
    const revoke = (threadId: ThreadId, providerSessionId: string) =>
      Effect.sync(() => revoked.add(providerSessionId)).pipe(
        Effect.andThen(
          Queue.offer(revocations, { threadId, providerSessionId, providerInstanceId: instanceId }),
        ),
      );
    yield* withCodeMode(
      (codeMode, runs) =>
        Effect.gen(function* () {
          const asking = yield* startTurn("revoked-asking");
          const waiting = yield* startAsking(codeMode, asking.threadId, "return 'asked'");
          yield* revoke(asking.threadId, credential);
          yield* respond(asking.threadId, waiting.requestId, "accept");
          assert.equal(refusal(yield* Fiber.await(waiting.script)), "CodeModeCredentialEndedError");

          const late = yield* startTurn("revoked-starting", "full-access");
          starting = Deferred.succeed(startBegan, undefined).pipe(
            Effect.andThen(Deferred.await(startGate)),
          );
          const script = yield* runScript(codeMode, late.threadId, "return 'started'", {
            providerSessionId: "credential:starting",
          }).pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(startBegan);
          yield* revoke(late.threadId, "credential:starting");
          yield* Deferred.succeed(startGate, undefined);
          assert.equal(refusal(yield* Fiber.join(script)), "CodeModeCredentialEndedError");

          assert.deepEqual(runs, []);
          const revokedNotice = "The provider session that started the previous session ended.";
          assert.ok(ended.length > 0 && ended.every((reason) => reason === revokedNotice));
        }),
      {
        revocations,
        revoked,
        ended,
        starting: Effect.suspend(() => starting),
      },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "ends an idle session when the thread's mode changes, even before its event arrives, but not for an unchanged mode",
  () =>
    Effect.gen(function* () {
      const endings = yield* Queue.unbounded<string>();
      const racedId = ThreadId.make("thread:mode-raced");
      const releaseRaced = yield* Deferred.make<void>();
      // Code Mode hears of the raced thread's mode change, and every later event, only once released.
      const holdRaced = (threads: Threads): Threads => ({
        ...threads,
        streamDomainEvents: threads.streamDomainEvents.pipe(
          Stream.mapEffect((event) =>
            event.threadId === racedId && event.type === "thread.runtime-mode-updated"
              ? Deferred.await(releaseRaced).pipe(Effect.as(event))
              : Effect.succeed(event),
          ),
        ),
      });
      yield* withCodeMode(
        (codeMode) =>
          Effect.gen(function* () {
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const modeChanged = "The thread's mode changed, so its session ended.";
            const raced = yield* startTurn("mode-raced", "full-access");
            yield* runScript(codeMode, raced.threadId, "return 1");
            yield* threads.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("mode:raced"),
              threadId: raced.threadId,
              runtimeMode: "auto",
            });
            assert.deepEqual(sessionOf(yield* runScript(codeMode, raced.threadId, "return 1")), {
              status: "done",
              result: null,
              sessionStarted: true,
              notice: modeChanged,
            });
            assert.equal(yield* Queue.take(endings), modeChanged);
            yield* Deferred.succeed(releaseRaced, undefined);

            const unchanged = yield* startTurn("mode-unchanged", "full-access");
            const changed = yield* startTurn("mode-changed-idle", "full-access");
            yield* runScript(codeMode, unchanged.threadId, "return 1");
            yield* runScript(codeMode, changed.threadId, "return 1");

            yield* threads.dispatch({
              type: "thread.interaction-mode.set",
              commandId: CommandId.make("mode:unchanged"),
              threadId: unchanged.threadId,
              interactionMode: "default",
            });
            yield* threads.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("mode:changed-idle"),
              threadId: changed.threadId,
              runtimeMode: "auto",
            });
            // Events arrive in order, so the raced and unchanged threads' events were handled too.
            assert.equal(yield* Queue.take(endings), modeChanged);

            for (const threadId of [raced.threadId, unchanged.threadId]) {
              assert.equal(
                (yield* runScript(codeMode, threadId, "return 1")).sessionStarted,
                undefined,
              );
            }
            assert.deepEqual(sessionOf(yield* runScript(codeMode, changed.threadId, "return 1")), {
              status: "done",
              result: null,
              sessionStarted: true,
              notice: modeChanged,
            });
          }),
        { endings, threads: holdRaced },
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "stops a running evaluation when its turn ends, the mode changes, the thread is archived, Code Mode is turned off, or T3 stops hearing about those changes",
  () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const settingChanges = yield* Queue.unbounded<ServerSettingsValue, Cause.Done>();
      const withEvents = (threads: Threads): Threads => ({
        ...threads,
        streamDomainEvents: Stream.merge(threads.streamDomainEvents, Stream.fromQueue(events)),
      });
      yield* withCodeMode(
        (codeMode) =>
          Effect.gen(function* () {
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const settings = yield* ServerSettings.ServerSettingsService;
            const cwd = yield* workspace;
            /** Starts a held evaluation, runs `stop`, and returns what the next call says. */
            const stoppedBy = Effect.fn("stoppedBy")(function* <E, R>(
              threadId: ThreadId,
              stop: Effect.Effect<unknown, E, R>,
            ) {
              const held = yield* holding();
              const started = yield* runScript(
                codeMode,
                threadId,
                "globalThis.kept = 1; await t3.hold();",
                {
                  bindings: held.bindings,
                },
              ).pipe(Effect.forkChild);
              yield* held.called;
              yield* TestClock.adjust(CodeMode.YIELD_AFTER);
              const { handle } = yield* Fiber.join(started);
              yield* stop;
              yield* held.stopped;
              return {
                handle,
                next: yield* runScript(codeMode, threadId, "return typeof globalThis.kept;"),
              };
            });

            const ended = yield* startTurn("turn-ended", "full-access", instanceId, cwd);
            const turnEnd = yield* stoppedBy(
              ended.threadId,
              Effect.gen(function* () {
                const projections = yield* ProjectionStore.ProjectionStoreV2;
                const { runs } = yield* threads.getThreadRecords(ended.threadId, ["runs"]);
                const run = runs[0]!;
                const now = yield* DateTime.now;
                const event = {
                  id: EventId.make("seed:turn-ended:interrupted"),
                  type: "run.updated",
                  threadId: ended.threadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: { ...run, status: "interrupted", completedAt: now },
                } as OrchestrationV2DomainEvent;
                yield* projections.apply(event);
                yield* startNextRun(ended.threadId, "turn-ended-next");
                yield* Queue.offer(events, event);
              }),
            );
            assert.deepEqual(sessionOf(turnEnd.next), {
              status: "done",
              result: "undefined",
              sessionStarted: true,
              notice: `The turn that started ${turnEnd.handle} ended, so its session was stopped.`,
            });

            const moved = yield* startTurn("mode-changed", "full-access", instanceId, cwd);
            const modeChange = yield* stoppedBy(
              moved.threadId,
              threads.dispatch({
                type: "thread.runtime-mode.set",
                commandId: CommandId.make("mode:mode-changed"),
                threadId: moved.threadId,
                runtimeMode: "auto",
              }),
            );
            assert.deepEqual(sessionOf(modeChange.next), {
              status: "done",
              result: "undefined",
              sessionStarted: true,
              notice: `The thread's mode changed while ${modeChange.handle} ran, so its session was stopped.`,
            });

            const archived = yield* startTurn("archived", "full-access", instanceId, cwd);
            const archive = yield* stoppedBy(
              archived.threadId,
              Effect.gen(function* () {
                const shell = yield* threads.getThreadShell(archived.threadId);
                yield* Queue.offer(events, {
                  id: EventId.make("seed:archived"),
                  type: "thread.archived",
                  threadId: archived.threadId,
                  occurredAt: yield* DateTime.now,
                  payload: shell,
                } as OrchestrationV2DomainEvent);
              }),
            );
            assert.deepEqual(sessionOf(archive.next), {
              status: "done",
              result: "undefined",
              sessionStarted: true,
              notice: "The thread was archived, so its session ended.",
            });

            const off = yield* startTurn("turned-off", "full-access", instanceId, cwd);
            const turnOff = yield* stoppedBy(
              off.threadId,
              settings.getSettings.pipe(
                Effect.flatMap((current) =>
                  Queue.offer(settingChanges, { ...current, codeModeEnabled: false }),
                ),
              ),
            );
            assert.deepEqual(sessionOf(turnOff.next), {
              status: "done",
              result: "undefined",
              sessionStarted: true,
              notice: "Code Mode was turned off, so every session ended.",
            });

            // Last: the setting watcher then keeps finding its stream ended.
            const lost = yield* startTurn("watch-lost", "full-access", instanceId, cwd);
            const lostWatch = yield* stoppedBy(lost.threadId, Queue.end(settingChanges));
            assert.deepEqual(sessionOf(lostWatch.next), {
              status: "done",
              result: "undefined",
              sessionStarted: true,
              notice: "T3 lost track of the changes that end sessions, so every session ended.",
            });
          }),
        { realRunner: true, threads: withEvents, settingChanges },
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a t3 call once the turn that started the evaluation has ended", () =>
  withCodeMode(
    (codeMode) =>
      Effect.gen(function* () {
        const { threadId } = yield* startTurn(
          "late-call",
          "full-access",
          instanceId,
          yield* workspace,
        );
        const called = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const reached: Array<string> = [];
        const bindings: CodeMode.CodeModeBindings = {
          tools: ["hold", "t3_thread_list"],
          call: (tool) =>
            tool === "hold"
              ? Deferred.succeed(called, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(null),
                )
              : Effect.sync(() => (reached.push(tool), null)),
        };
        const script = yield* runScript(
          codeMode,
          threadId,
          "await t3.hold(); return await t3.t3_thread_list({}).catch((error) => error.message);",
          { bindings },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(called);
        // The turn ends without an event, so only the call's own check can refuse it.
        yield* startNextRun(threadId, "late-call-next");
        yield* Deferred.succeed(release, undefined);

        assert.equal(
          (yield* Fiber.join(script)).result,
          "t3.t3_thread_list was refused: the turn that started this evaluation has ended.",
        );
        assert.deepEqual(reached, []);
      }),
    { realRunner: true },
  ).pipe(Effect.provide(layerTest)),
);

it.effect("ends a session after 10 idle minutes", () =>
  withCodeMode(
    (codeMode) =>
      Effect.gen(function* () {
        const { threadId } = yield* startTurn("idle", "full-access", instanceId, yield* workspace);
        yield* runScript(codeMode, threadId, "globalThis.kept = 1;");
        yield* TestClock.adjust(Duration.subtract(CodeMode.IDLE_TIMEOUT, Duration.seconds(1)));
        assert.equal(
          (yield* runScript(codeMode, threadId, "return typeof globalThis.kept;")).result,
          "number",
        );
        yield* TestClock.adjust(CodeMode.IDLE_TIMEOUT);
        assert.deepEqual(
          sessionOf(yield* runScript(codeMode, threadId, "return typeof globalThis.kept;")),
          {
            status: "done",
            result: "undefined",
            sessionStarted: true,
            notice: "The previous session ended after 10 idle minutes.",
          },
        );
      }),
    { realRunner: true },
  ).pipe(Effect.provide(layerTest)),
);

it.effect("stops the least recently used idle session to start one past the limit", () =>
  Effect.gen(function* () {
    const ended: Array<string> = [];
    const began = yield* Queue.unbounded<void>();
    let starting: Effect.Effect<void> = Effect.void;
    yield* withCodeMode(
      (codeMode) =>
        Effect.gen(function* () {
          const threadIds: Array<ThreadId> = [];
          for (let index = 0; index < CodeMode.SESSION_LIMIT + 2; index++) {
            threadIds.push((yield* startTurn(`lru-${index}`, "full-access")).threadId);
          }
          const at = (index: number) => threadIds[index]!;
          for (const threadId of threadIds.slice(0, CodeMode.SESSION_LIMIT)) {
            yield* runScript(codeMode, threadId, "return 1");
          }
          yield* runScript(codeMode, at(0), "return 1");
          assert.deepEqual(ended, []);

          // Two first calls past the limit at once: each takes its own place.
          const release = yield* Deferred.make<void>();
          starting = Queue.offer(began, undefined).pipe(Effect.andThen(Deferred.await(release)));
          const concurrent = yield* Effect.forEach(
            [at(CodeMode.SESSION_LIMIT), at(CodeMode.SESSION_LIMIT + 1)],
            (threadId) => runScript(codeMode, threadId, "return 1").pipe(Effect.forkChild),
          );
          yield* Queue.take(began);
          yield* Queue.take(began);
          starting = Effect.void;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.joinAll(concurrent);
          const evicted =
            "The previous session was stopped to make room: at most 16 sessions run at once.";
          assert.deepEqual(ended, [evicted, evicted]);
          assert.equal((yield* runScript(codeMode, at(0), "return 1")).sessionStarted, undefined);

          // Every session runs but the most recently used, so that one makes room.
          const running = yield* Effect.forEach(
            [...threadIds.slice(3, CodeMode.SESSION_LIMIT + 1), at(0)],
            (threadId) => runScript(codeMode, threadId, HOLD).pipe(Effect.forkChild),
          );
          yield* TestClock.adjust(CodeMode.YIELD_AFTER);
          yield* Fiber.joinAll(running);
          yield* runScript(codeMode, at(CodeMode.SESSION_LIMIT + 1), "return 1");
          const replacing = yield* runScript(codeMode, at(1), HOLD).pipe(Effect.forkChild);
          yield* TestClock.adjust(CodeMode.YIELD_AFTER);
          assert.deepEqual(sessionOf(yield* Fiber.join(replacing)), {
            status: "running",
            result: undefined,
            sessionStarted: true,
            notice: evicted,
          });
          assert.deepEqual(ended, [evicted, evicted, evicted]);
          const lru = yield* runScript(codeMode, at(3), "return 1").pipe(Effect.flip);
          assert.equal(lru._tag, "CodeModeBusyError");

          const full = yield* runScript(codeMode, at(2), "return 1").pipe(Effect.flip);
          assert.equal(
            full.message,
            "All 16 JavaScript sessions on this machine are running scripts, so a new one cannot start. Try again once one finishes.",
          );
        }),
      { ended, starting: Effect.suspend(() => starting) },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("starts a new session when the previous one's process exited on its own", () => {
  const exited: { reason: string | undefined } = { reason: undefined };
  return withCodeMode(
    (codeMode) =>
      Effect.gen(function* () {
        const { threadId } = yield* startTurn("exited", "full-access");
        yield* runScript(codeMode, threadId, "return 1");
        exited.reason = "The session's process exited with code 1.";
        const next = yield* runScript(codeMode, threadId, "return 1");
        exited.reason = undefined;
        assert.deepEqual(sessionOf(next), {
          status: "done",
          result: null,
          sessionStarted: true,
          notice: "The session's process exited with code 1.",
        });
      }),
    { exited },
  ).pipe(Effect.provide(layerTest));
});

it.effect("refuses a second script while one runs without asking about it", () =>
  withCodeMode(
    (codeMode) =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const { threadId } = yield* startTurn(
          "busy-asks",
          "approval-required",
          instanceId,
          yield* workspace,
        );
        const held = yield* holding();
        const afterSequence = yield* threads.getThreadEventSequence(threadId);
        const first = yield* runScript(codeMode, threadId, "await t3.hold();", {
          bindings: held.bindings,
        }).pipe(Effect.forkChild);
        yield* respond(threadId, yield* pendingCardAfter(threadId, afterSequence), "accept");
        yield* held.called;
        yield* TestClock.adjust(CodeMode.YIELD_AFTER);
        const { handle } = yield* Fiber.join(first);

        const busy = yield* runScript(codeMode, threadId, "return 2").pipe(Effect.flip);
        assert.equal(busy.message, `${handle} is still running: poll it or call t3_code_reset.`);
        const { runtimeRequests } = yield* threads.getThreadRecords(threadId, ["runtimeRequests"]);
        assert.equal(runtimeRequests.length, 1);
      }),
    { realRunner: true },
  ).pipe(Effect.provide(layerTest)),
);
