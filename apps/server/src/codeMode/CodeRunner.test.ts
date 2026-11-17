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

const run = Effect.fn("run")(function* (
  code: string,
  options: { readonly cwd?: string; readonly environment?: NodeJS.ProcessEnv } = {},
) {
  const runner = yield* CodeRunner.CodeRunner;
  return yield* runner.run({
    code,
    cwd: options.cwd ?? (yield* workspace()),
    environment: options.environment ?? { PATH: (yield* HostProcess.Environment).PATH },
  });
});

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
          {
            cwd,
          },
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
      const fiber = yield* run(report.script).pipe(Effect.forkChild);
      const pid = yield* report.pid;
      expect(isRunning(pid)).toBe(true);

      yield* TestClock.adjust("10 minutes");
      const output = yield* Fiber.join(fiber);

      expect(output.error).toBe("The script ran longer than 10 minutes and was stopped.");
      expect(isRunning(pid)).toBe(false);
    }),
  );

  it.effect("returns once the grace ends while a detached process holds the pipes", () =>
    Effect.gen(function* () {
      const report = yield* pidReport(
        `const pid = String(require("node:child_process").spawn("sleep", ["15"], { detached: true, stdio: "inherit" }).pid);`,
      );
      const fiber = yield* run(report.script).pipe(Effect.forkChild);
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

  it.effect("kills what a script started when the call is interrupted", () =>
    Effect.gen(function* () {
      const report = yield* pidReport();
      const fiber = yield* run(report.script).pipe(Effect.forkChild);
      const pid = yield* report.pid;
      expect(isRunning(pid)).toBe(true);

      yield* Fiber.interrupt(fiber);

      expect(isRunning(pid)).toBe(false);
    }),
  );

  it.effect("kills what a script left running after it returns", () =>
    Effect.gen(function* () {
      const output = yield* run(
        `return Number((await $\`sleep 300 >/dev/null 2>&1 & echo $!\`.text()).trim());`,
      );
      expect(output.error).toBeNull();
      expect(isRunning(output.result as number)).toBe(false);
    }),
  );
});

// Live: the grace starts when the real process exits, which a test clock cannot observe.
it.live("returns a script's value when a detached process it started holds the pipes", () =>
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
    expect(output.truncated).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
