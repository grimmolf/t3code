import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as NodeNet from "node:net";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as CodeRunner from "./CodeRunner.ts";

const layerTest = CodeRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const workspace = Effect.fn("workspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-code-run-" });
});

const noCalls: CodeRunner.EvaluateInput["call"] = () =>
  Effect.die("This script makes no t3 calls.");

/** A session in the current scope. */
const session = Effect.fn("session")(function* (
  options: {
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const runner = yield* CodeRunner.CodeRunner;
  return yield* runner.start({
    cwd: options.cwd ?? (yield* workspace()),
    environment: options.environment ?? { PATH: (yield* HostProcess.Environment).PATH },
  });
});

/** One evaluation in a session of its own, which ends with it. */
const run = (
  code: string,
  options: { readonly cwd?: string; readonly environment?: NodeJS.ProcessEnv } = {},
) =>
  Effect.scoped(
    Effect.flatMap(session(options), (started) =>
      started.evaluate({ code, tools: [], call: noCalls }),
    ),
  );

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const shellChild = `const pid = (await $\`sleep 300 >/dev/null 2>&1 & echo $!\`.text()).trim();`;

/** A socket the script reports its background child's PID to, once that child runs. */
const pidReport = Effect.fn("pidReport")(function* (startChild: string = shellChild) {
  const path = yield* Path.Path;
  const socketPath = path.join(yield* workspace(), "pid.sock");
  const reported = yield* Deferred.make<number>();
  const server = NodeNet.createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => Deferred.doneUnsafe(reported, Effect.succeed(Number(text))));
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(socketPath, () => resume(Effect.void));
    }),
    () => Effect.sync(() => server.close()),
  );
  const script = [
    startChild,
    `await new Promise((resolve) => require("node:net").connect(${JSON.stringify(socketPath)}).end(pid, resolve));`,
    `await new Promise((resolve) => setTimeout(resolve, 3_600_000));`,
  ].join("\n");
  return { script, pid: Deferred.await(reported) };
});

it.layer(layerTest)("CodeRunner", (it) => {
  describe("edit", () => {
    it.effect("replaces one occurrence and refuses zero or several", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* workspace();
        yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "one two two\n");

        const once = yield* run(
          `edit("a.ts", "one", "1"); return fs.readFileSync("a.ts", "utf8");`,
          { cwd },
        );
        expect(once).toMatchObject({ result: "1 two two\n", error: null });

        const missing = yield* run(`edit("a.ts", "three", "3");`, { cwd });
        expect(missing.error).toContain("oldText occurs 0 times");
        const repeated = yield* run(`edit("a.ts", "two", "2");`, { cwd });
        expect(repeated.error).toContain("oldText occurs 2 times");
        expect(yield* fileSystem.readFileString(path.join(cwd, "a.ts"))).toBe("1 two two\n");
      }),
    );
  });

  describe("$", () => {
    it.effect("quotes values and keeps the template's backslashes", () =>
      Effect.gen(function* () {
        const output = yield* run(
          [
            'const quoted = await $`printf \'%s|\' ${"it\'s a $HOME"} ${["x y", "z"]}`.text();',
            "const raw = await $`printf '%s' 'a\\|b'`.text();",
            "return { quoted, raw };",
          ].join("\n"),
        );
        expect(output).toMatchObject({
          result: { quoted: "it's a $HOME|x y|z|", raw: "a\\|b" },
          error: null,
        });
      }),
    );

    it.effect("rejects a nonzero exit unless nothrow is used", () =>
      Effect.gen(function* () {
        const thrown = yield* run(`await $\`echo nope >&2; exit 3\`;`);
        expect(thrown.error).toContain("Command exited with code 3");
        expect(thrown.error).toContain("nope");

        const kept = yield* run(`const r = await $\`echo out; exit 3\`.nothrow(); return r;`);
        expect(kept).toMatchObject({
          result: { stdout: "out\n", stderr: "", exitCode: 3 },
          error: null,
        });
      }),
    );

    it.effect("keeps the end of each stream past 8 MiB and says it was cut", () =>
      Effect.gen(function* () {
        const output = yield* run(
          [
            "const long = await $`yes | head -c 9000000`;",
            "const short = await $`echo hi`;",
            "return [long.stdout.length, long.stdout.slice(-2), long.truncated, short.truncated];",
          ].join("\n"),
        );
        expect(output).toMatchObject({
          result: [8 * 1024 * 1024, "y\n", true, false],
          truncated: true,
          error: null,
        });
      }),
    );

    it.effect("gives shell children T3's environment without its credentials or settings", () =>
      Effect.gen(function* () {
        const output = yield* run(
          `return $\`printf '%s|%s|%s|%s|%s' "$ELECTRON_RUN_AS_NODE" "$T3_MCP_BEARER_TOKEN" "$T3CODE_DEV_AUTH_TOKEN" "$VITE_WS_URL" "$KEEP"\`.text();`,
          {
            environment: {
              PATH: (yield* HostProcess.Environment).PATH,
              ELECTRON_RUN_AS_NODE: "1",
              T3_MCP_BEARER_TOKEN: "secret",
              T3CODE_DEV_AUTH_TOKEN: "secret",
              VITE_WS_URL: "ws://localhost",
              KEEP: "kept",
            },
          },
        );
        expect(output).toMatchObject({ result: "||||kept", error: null });
      }),
    );
  });

  it.effect("caps the whole response at 64 KiB and says so", () =>
    Effect.gen(function* () {
      const output = yield* run(
        `process.stdout.write("o".repeat(200_000)); return { big: "r".repeat(100_000) };`,
      );
      expect(output.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(64 * 1024);
      expect(output.result).toEqual(expect.stringMatching(/^\{"big":"rrr/));
      expect(output.error).toBeNull();
    }),
  );

  it.effect("awaits fs calls, and lets a script declare its own fs", () =>
    Effect.gen(function* () {
      const cwd = yield* workspace();
      const awaited = yield* run(
        `await fs.writeFile("note.txt", "hi"); return await fs.readFile("note.txt", "utf8");`,
        { cwd },
      );
      expect(awaited).toMatchObject({ result: "hi", error: null });
      const redeclared = yield* run(
        `const fs = require("node:fs"); return fs.readFileSync("note.txt", "utf8");`,
        { cwd },
      );
      expect(redeclared).toMatchObject({ result: "hi", error: null });
    }),
  );

  it.effect("stops a script at the timeout and kills what it started", () =>
    Effect.gen(function* () {
      const report = yield* pidReport();
      const started = yield* session();
      const fiber = yield* started
        .evaluate({ code: report.script, tools: [], call: noCalls })
        .pipe(Effect.forkChild);
      const pid = yield* report.pid;
      expect(isRunning(pid)).toBe(true);

      yield* TestClock.adjust("10 minutes");
      const output = yield* Fiber.join(fiber);

      expect(output.error).toBe("The script ran longer than 10 minutes and was stopped.");
      expect(isRunning(pid)).toBe(false);
      expect(yield* started.ended).toBe("The script ran longer than 10 minutes and was stopped.");
    }),
  );

  it.effect("returns once the grace ends while a detached process holds the pipes", () =>
    Effect.gen(function* () {
      const report = yield* pidReport(
        `const pid = String(require("node:child_process").spawn("sleep", ["15"], { detached: true, stdio: "inherit" }).pid);`,
      );
      const started = yield* session();
      const fiber = yield* started
        .evaluate({ code: report.script, tools: [], call: noCalls })
        .pipe(Effect.forkChild);
      const pid = yield* report.pid;
      yield* Effect.addFinalizer(() => Effect.sync(() => isRunning(pid) && process.kill(pid)));

      yield* TestClock.adjust(Duration.sum(CodeRunner.RUN_TIMEOUT, CodeRunner.PIPE_GRACE));
      const output = yield* Fiber.join(fiber);

      expect(output.truncated).toBe(true);
      expect(output.error).toBe(
        "The script ran longer than 10 minutes and was stopped.\nOutput was cut off because a background process the script started kept its output open.",
      );
    }),
  );

  it.effect("gives a running evaluation the reason its session was ended", () =>
    Effect.gen(function* () {
      const report = yield* pidReport();
      const started = yield* session();
      const fiber = yield* started
        .evaluate({ code: report.script, tools: [], call: noCalls })
        .pipe(Effect.forkChild);
      const pid = yield* report.pid;

      yield* started.end("Reset by t3_code_reset.");

      expect((yield* Fiber.join(fiber)).error).toBe("Reset by t3_code_reset.");
      expect(isRunning(pid)).toBe(false);
    }),
  );

  it.effect("kills what scripts started when the session's scope closes", () =>
    Effect.gen(function* () {
      const report = yield* pidReport();
      const fiber = yield* run(report.script).pipe(Effect.forkChild);
      const pid = yield* report.pid;
      expect(isRunning(pid)).toBe(true);

      yield* Fiber.interrupt(fiber);

      expect(isRunning(pid)).toBe(false);
    }),
  );

  it.effect("kills what a script left running once its session ends", () =>
    Effect.gen(function* () {
      const output = yield* run(
        `return Number((await $\`sleep 300 >/dev/null 2>&1 & echo $!\`.text()).trim());`,
      );
      expect(output.error).toBeNull();
      expect(isRunning(output.result as number)).toBe(false);
    }),
  );

  it("gives the next evaluation's stderr the last 4 KiB of what arrived between evaluations, then its own", () => {
    const stderr = CodeRunner.makeOutput(true);
    const capture = (marker: string) => ({
      marker,
      text: "",
      bytes: 0,
      truncated: false,
      earlierCut: false,
      seen: Deferred.makeUnsafe<void>(),
    });
    const feed = (text: string) => stderr.feed(new TextEncoder().encode(text));

    const first = capture("<1>");
    stderr.install(first);
    feed("one<1>after");
    feed(" between");
    const second = capture("<2>");
    stderr.install(second);
    feed(" two<2>");
    // 4 KiB from the end falls inside a two-byte é, so the kept part starts at the next one.
    feed("é".repeat(CodeRunner.RESPONSE_LIMIT_BYTES) + "TAIL!");
    const third = capture("<3>");
    stderr.install(third);
    feed("own<3>");

    expect([first.text, second.text]).toEqual(["one", "after between two"]);
    expect(third).toMatchObject({ text: "é".repeat(2045) + "TAIL!own", earlierCut: true });
  });

  describe("session", () => {
    it.effect("keeps globalThis between evaluations, and each one's own output", () =>
      Effect.gen(function* () {
        const started = yield* session();
        const evaluate = (code: string) => started.evaluate({ code, tools: [], call: noCalls });

        const first = yield* evaluate(
          // lines, path and pending are also names the runner uses for itself.
          `globalThis.kept = 1; globalThis.lines = ["a", "b"]; globalThis.path = "p"; globalThis.pending = 3; var local = 2; let block = 3; function helper() {} console.log("one");`,
        );
        const second = yield* evaluate(
          `console.log("two"); return [typeof kept, typeof local, typeof block, typeof helper, lines.length, path, pending];`,
        );

        expect(first).toMatchObject({ stdout: "one\n", error: null });
        expect(second).toMatchObject({
          result: ["number", "undefined", "undefined", "undefined", 2, "p", 3],
          stdout: "two\n",
          error: null,
        });
      }),
    );

    it.effect(
      "returns at once, with what it wrote last, when a script exits the process or breaks the runner",
      () =>
        Effect.gen(function* () {
          const started = yield* session();
          const output = yield* started.evaluate({
            code: `await new Promise((resolve) => process.stdout.write("bye\\n", resolve)); process.exit(7);`,
            tools: [],
            call: noCalls,
          });

          expect(output).toMatchObject({
            stdout: "bye\n",
            error: "The session's process exited with code 7.",
          });
          expect(yield* started.ended).toBe("The session's process exited with code 7.");

          // The runner cannot send its result, or its channel to T3 is gone.
          for (const [code, failure] of [
            [
              "JSON.stringify = () => { throw new Error('sabotaged'); }; return 1;",
              "Error: sabotaged",
            ],
            ["require('node:fs').closeSync(3); return 1;", "Error: EBADF"],
          ] as const) {
            const broken = yield* session();
            expect(yield* broken.evaluate({ code, tools: [], call: noCalls })).toMatchObject({
              error: "The session's process exited with code 70.",
              stderr: expect.stringContaining(`T3's code runner failed: ${failure}`),
            });
          }
        }),
    );

    it.effect("keeps the session when a script or its callback throws, and reports the error", () =>
      Effect.gen(function* () {
        const started = yield* session();
        const evaluate = (code: string) => started.evaluate({ code, tools: [], call: noCalls });

        const thrown = yield* evaluate(
          [
            "globalThis.kept = 1;",
            "setTimeout(() => { throw new Error('boom'); }, 0);",
            "await new Promise((resolve) => setTimeout(resolve, 0));",
            "return 'after';",
          ].join("\n"),
        );

        expect(thrown).toMatchObject({ result: "after", error: null });
        expect(thrown.stderr).toContain("Uncaught error: Error: boom");
        expect((yield* evaluate("throw Object.create(null);")).error).toBe(
          "A thrown value that cannot be shown as text.",
        );
        expect((yield* evaluate("return typeof kept;")).result).toBe("number");
      }),
    );
  });

  describe("t3", () => {
    const tools = ["t3_thread_list", "t3_thread_read"];

    it.effect("lists its tools, calls them, and throws their failures", () =>
      Effect.gen(function* () {
        const started = yield* session();
        const calls: Array<[string, unknown]> = [];
        const output = yield* started.evaluate({
          tools,
          code: [
            "const threads = await t3.t3_thread_list({ limit: 2 });",
            "const failure = await t3.t3_thread_read({ threadId: 'gone' }).catch((error) => [error.message, error.code, error.tool]);",
            "return { tools: t3.tools(), wait: typeof t3.t3_thread_wait, threads, failure };",
          ].join("\n"),
          call: (tool, args) => {
            calls.push([tool, args]);
            return tool === "t3_thread_list"
              ? Effect.succeed({ threads: [] })
              : Effect.fail(
                  new CodeRunner.CodeToolCallError({
                    reason: "Thread gone was not found.",
                    code: "thread_not_found",
                  }),
                );
          },
        });

        expect(output).toMatchObject({
          result: {
            tools,
            wait: "undefined",
            threads: { threads: [] },
            failure: ["Thread gone was not found.", "thread_not_found", "t3_thread_read"],
          },
          error: null,
          t3Calls: 2,
        });
        expect(calls).toEqual([
          ["t3_thread_list", { limit: 2 }],
          ["t3_thread_read", { threadId: "gone" }],
        ]);
      }),
    );

    it.effect("refuses arguments it cannot send, and keeps the session", () =>
      Effect.gen(function* () {
        const started = yield* session();
        const calls: Array<string> = [];
        const output = yield* started.evaluate({
          tools,
          code: [
            "const circular = {}; circular.self = circular;",
            "const refused = [];",
            "for (const args of [{ n: 10n }, circular, () => 1, { text: 'x'.repeat(2_000_000) }]) {",
            "  refused.push(await t3.t3_thread_list(args).then(() => 'sent', (error) => [error.name, error.message]));",
            "}",
            // Refused in the session, before any reply from T3 could arrive.
            "let refusedAtOnce = false;",
            "const large = t3.t3_thread_list({ text: 'x'.repeat(100_000) }).catch(() => { refusedAtOnce = true; });",
            "await null; await null;",
            "const early = refusedAtOnce; await large;",
            "return { refused, early, after: await t3.t3_thread_read({}) };",
          ].join("\n"),
          call: (tool) => Effect.sync(() => (calls.push(tool), "read")),
        });

        const notJson = "t3.t3_thread_list: its arguments cannot be sent as JSON";
        expect(output).toMatchObject({
          result: {
            refused: [
              ["T3ToolError", expect.stringMatching(new RegExp(`^${notJson}: .*BigInt`))],
              ["T3ToolError", expect.stringMatching(new RegExp(`^${notJson}: .*circular`))],
              ["T3ToolError", `${notJson}.`],
              ["T3ToolError", "t3.t3_thread_list: the request is larger than 64 KiB."],
            ],
            early: true,
            after: "read",
          },
          error: null,
          t3Calls: 1,
        });
        expect(calls).toEqual(["t3_thread_read"]);
      }),
    );

    it.effect(
      "refuses a call line over 64 KiB, in any key order, without stopping the session",
      () =>
        Effect.gen(function* () {
          const started = yield* session();
          const sizes: Array<number> = [];
          const output = yield* started.evaluate({
            tools,
            code: [
              "const writeAll = (line) => { const data = Buffer.from(line); for (let at = 0; at < data.length; ) at += require('node:fs').writeSync(3, data, at); };",
              `writeAll('{"type":"call","evaluation":"forged","callId":999999,"tool":"t3_thread_list","args":"' + "x".repeat(2_000_000) + '"}\\n');`,
              // Read off a real call, so only the size check can refuse the forged one below.
              "const { Writable } = require('node:stream');",
              "const write = Writable.prototype.write;",
              "let evaluation;",
              `Writable.prototype.write = function (chunk, ...rest) { evaluation ??= /"evaluation":("[^"]+")/.exec(String(chunk))?.[1]; return write.call(this, chunk, ...rest); };`,
              "await t3.t3_thread_list({});",
              "Writable.prototype.write = write;",
              "writeAll(JSON.stringify({ args: 'x'.repeat(100_000), type: 'call', evaluation: JSON.parse(evaluation), callId: 999998, tool: 't3_thread_list' }) + '\\n');",
              "return await t3.t3_thread_list({});",
            ].join("\n"),
            call: (_tool, args) =>
              Effect.sync(() => (sizes.push(JSON.stringify(args).length), "listed")),
          });

          expect(output).toMatchObject({ result: "listed", error: null, t3Calls: 2 });
          expect(sizes).toEqual([2, 2]);
        }),
    );

    it.effect(
      "stops the t3 calls an evaluation did not await once it returns, or ends the session if one will not stop",
      () =>
        Effect.gen(function* () {
          const started = yield* session();
          const held = yield* Deferred.make<void>();
          const stopped = yield* Deferred.make<void>();
          const call: CodeRunner.EvaluateInput["call"] = (tool) =>
            tool === "hold"
              ? Deferred.succeed(held, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
                )
              : Deferred.await(held).pipe(Effect.as(null));
          yield* started.evaluate({
            tools: ["hold", "ready"],
            code: "globalThis.holding = t3.hold(); await t3.ready();",
            call,
          });

          expect(yield* Deferred.isDone(stopped)).toBe(true);
          const later = yield* started.evaluate({
            tools: [],
            code: "return await holding.catch((error) => error.message);",
            call,
          });
          expect(later.result).toBe(
            "t3.hold was stopped: the evaluation that called it has finished.",
          );

          const interrupted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const stuck = yield* started
            .evaluate({
              tools: ["stuck"],
              code: "t3.stuck(); return 'returned';",
              call: () =>
                Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Deferred.succeed(interrupted, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                ),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(interrupted);
          yield* TestClock.adjust(CodeRunner.CALL_STOP_GRACE);
          expect((yield* Fiber.join(stuck)).result).toBe("returned");
          expect(yield* started.ended).toBe(
            "A t3 call did not stop when its evaluation finished, so the session was stopped.",
          );
        }),
    );

    it.effect("refuses a call from a callback of an evaluation that has finished", () =>
      Effect.gen(function* () {
        const started = yield* session();
        const calls: Array<string> = [];
        const call: CodeRunner.EvaluateInput["call"] = (tool) =>
          Effect.sync(() => (calls.push(tool), null));
        yield* started.evaluate({
          tools,
          code: [
            "globalThis.ticked = new Promise((resolve) => {",
            "  const timer = setInterval(() => {",
            "    if (!globalThis.armed) return;",
            "    clearInterval(timer);",
            "    t3.t3_thread_list({});",
            "    t3.t3_thread_list({}).then(() => resolve('ran'), (error) => resolve(error.message));",
            "  }, 5);",
            "});",
          ].join("\n"),
          call,
        });
        // The first late call has no rejection handler, which must not end the session.
        const output = yield* started.evaluate({
          tools,
          code: "globalThis.armed = true; const message = await ticked; await new Promise((resolve) => setImmediate(resolve)); return message;",
          call,
        });

        const refused = "t3.t3_thread_list was called by an evaluation that has already finished.";
        expect(output).toMatchObject({ result: refused, error: null });
        expect(output.stderr).toContain(`Unhandled rejection: T3ToolError: ${refused}`);
        expect(calls).toEqual([]);
      }),
    );

    it.effect("runs at most 8 calls at once in one evaluation", () =>
      Effect.gen(function* () {
        const started = yield* session();
        const output = yield* started.evaluate({
          tools,
          code: [
            "const calls = Array.from({ length: 9 }, () => t3.t3_thread_list({}));",
            "return await calls[8].then(() => 'ran', (error) => error.message);",
          ].join("\n"),
          call: () => Effect.never,
        });

        expect(output).toMatchObject({
          result: "t3.t3_thread_list: at most 8 t3 calls can run at once in one evaluation.",
          t3Calls: 8,
        });
      }),
    );
  });
});

// Live: the grace starts when the real process exits, which a test clock cannot observe.
it.live("returns a script's value while a detached process it started holds the pipes", () =>
  Effect.gen(function* () {
    const output = yield* run(
      `const child = require("node:child_process").spawn("sleep", ["15"], { detached: true, stdio: "inherit" });
       child.unref();
       return { value: 2, pid: child.pid };`,
    );
    const { value, pid } = output.result as { value: number; pid: number };
    yield* Effect.addFinalizer(() => Effect.sync(() => isRunning(pid) && process.kill(pid)));

    expect(value).toBe(2);
    expect(output.error).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
