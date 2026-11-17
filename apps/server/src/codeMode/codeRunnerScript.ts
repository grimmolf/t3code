/**
 * Runs as `node -e` in its own process group, one per session. It reads JSON lines from fd 4
 * (`evaluate`, `reply`) and writes JSON lines to fd 3 (`result`, `call`). Each evaluation ends
 * by writing its marker to stdout and stderr, then its result. It exits when fd 4 closes.
 * No `${` below: this is a template literal.
 */
export const CODE_RUNNER_SCRIPT = String.raw`"use strict";
delete process.env.ELECTRON_RUN_AS_NODE;
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const childProcess = require("node:child_process");
const { createRequire } = require("node:module");
const { AsyncLocalStorage } = require("node:async_hooks");

const RESULT_LIMIT = 64 * 1024;
const CALL_LIMIT = 64 * 1024;
// What $ keeps of each stream a command writes: the end, where errors and summaries land.
const SHELL_OUTPUT_LIMIT = 8 * 1024 * 1024;

const quote = (value) => {
  if (Array.isArray(value)) return value.map(quote).join(" ");
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
};

class ShellError extends Error {
  constructor(command, result) {
    super("Command exited with code " + result.exitCode + ": " + command + (result.stderr ? "\n" + result.stderr.slice(-4000) : ""));
    this.name = "ShellError";
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
  }
}

const collect = (stream) => {
  const kept = { chunks: [], bytes: 0, cut: false };
  stream.on("data", (chunk) => {
    kept.chunks.push(chunk);
    kept.bytes += chunk.length;
    while (kept.bytes - kept.chunks[0].length >= SHELL_OUTPUT_LIMIT) {
      kept.bytes -= kept.chunks.shift().length;
      kept.cut = true;
    }
  });
  return kept;
};

const tail = (kept) => {
  const whole = Buffer.concat(kept.chunks);
  if (whole.length <= SHELL_OUTPUT_LIMIT) return whole.toString("utf8");
  kept.cut = true;
  let start = whole.length - SHELL_OUTPUT_LIMIT;
  while (start < whole.length && (whole[start] & 0xc0) === 0x80) start++;
  return whole.subarray(start).toString("utf8");
};

const $ = (strings, ...values) => {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    const tick = String.fromCharCode(96);
    throw new TypeError("$ is a template tag: write $" + tick + "command" + tick + ".");
  }
  const command = strings.raw.reduce(
    (text, part, index) => text + part + (index < values.length ? quote(values[index]) : ""),
    "",
  );
  const running = evaluation.getStore();
  const finished = new Promise((resolve) => {
    const child = childProcess.spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    child.on("error", (error) => resolve({ stdout: "", stderr: error.message, exitCode: 127, truncated: false }));
    child.on("close", (code, signal) => {
      const result = {
        stdout: tail(stdout),
        stderr: tail(stderr),
        exitCode: code ?? 128 + (os.constants.signals[signal] ?? 0),
        truncated: stdout.cut || stderr.cut,
      };
      if (result.truncated && running !== undefined) running.truncated = true;
      resolve(result);
    });
  });
  let check = true;
  const settled = () =>
    finished.then((result) => {
      if (check && result.exitCode !== 0) throw new ShellError(command, result);
      return result;
    });
  const run = {
    then: (onFulfilled, onRejected) => settled().then(onFulfilled, onRejected),
    catch: (onRejected) => settled().catch(onRejected),
    finally: (onFinally) => settled().finally(onFinally),
    nothrow: () => {
      check = false;
      return run;
    },
    text: () => settled().then((result) => result.stdout),
  };
  return run;
};

const edit = (file, oldText, newText) => {
  if (typeof oldText !== "string" || oldText === "") {
    throw new TypeError("edit(" + file + "): oldText must be a non-empty string.");
  }
  const target = path.resolve(file);
  const text = fs.readFileSync(target, "utf8");
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error("edit(" + file + "): oldText occurs " + count + " times; it must occur exactly once.");
  }
  fs.writeFileSync(target, text.replace(oldText, () => String(newText)));
};

const channel = fs.createWriteStream("", { fd: 3 });
const send = (message) => new Promise((resolve) => channel.write(JSON.stringify(message) + "\n", resolve));
const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);
const mark = (write, marker) => new Promise((resolve) => write(marker, () => resolve()));

// As in Node's REPL, an error no caller can catch goes to stderr and the session keeps running.
const report = (label) => (error) => {
  writeErr(label + ": " + (error instanceof Error ? (error.stack ?? error.message) : String(error)) + "\n");
};
process.on("uncaughtException", report("Uncaught error"));
process.on("unhandledRejection", report("Unhandled rejection"));

// Holds the running evaluation's id, and whether a $ command's output was cut.
const evaluation = new AsyncLocalStorage();
const pending = new Map();
let nextCallId = 0;

class T3ToolError extends Error {
  constructor(tool, message, code) {
    super(message);
    this.name = "T3ToolError";
    this.tool = tool;
    if (code !== undefined) this.code = code;
  }
}

const call = (tool, args) => {
  const running = evaluation.getStore();
  if (running === undefined) {
    return Promise.reject(new T3ToolError(tool, "t3." + tool + " was called outside a running evaluation."));
  }
  let encoded;
  try {
    encoded = JSON.stringify(args === undefined ? {} : args);
  } catch (error) {
    return Promise.reject(new T3ToolError(tool, "t3." + tool + ": its arguments cannot be sent as JSON: " + error.message));
  }
  if (encoded === undefined) {
    return Promise.reject(new T3ToolError(tool, "t3." + tool + ": its arguments cannot be sent as JSON."));
  }
  const callId = ++nextCallId;
  // T3 reads callId and tool from the start of a line too long to parse, so they precede args.
  const line = '{"type":"call","evaluation":' + JSON.stringify(running.id) + ',"callId":' + callId +
    ',"tool":' + JSON.stringify(tool) + ',"args":' + encoded + "}\n";
  if (Buffer.byteLength(line) > CALL_LIMIT) {
    return Promise.reject(new T3ToolError(tool, "t3." + tool + ": the request is larger than 64 KiB."));
  }
  return new Promise((resolve, reject) => {
    pending.set(callId, { tool, resolve, reject });
    channel.write(line);
  });
};

const toolsOf = (names) =>
  Object.freeze(
    Object.fromEntries([
      ["tools", () => [...names]],
      ...names.map((name) => [name, (args) => call(name, args)]),
    ]),
  );

const AsyncFunction = (async () => {}).constructor;
// Promise forms of the async calls, so await fs.readFile works; sync calls stay as they are.
const scriptFs = Object.create(fs, Object.getOwnPropertyDescriptors(fs.promises));
const scriptRequire = createRequire(path.join(process.cwd(), "t3-code-run.js"));
const cut = (text) => (text.length > RESULT_LIMIT ? { text: text.slice(0, RESULT_LIMIT), cut: true } : { text, cut: false });

const evaluate = async ({ id, code, marker, tools }) => {
  const running = { id, truncated: false };
  let message;
  try {
    // An inner function lets the script declare its own fs, $, edit, require or t3.
    const script = new AsyncFunction("$", "edit", "require", "fs", "t3", "return (async () => {\n" + code + "\n})();");
    const value = await evaluation.run(running, () => script($, edit, scriptRequire, scriptFs, toolsOf(tools)));
    let json;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      throw new Error("The return value cannot be encoded as JSON: " + error.message);
    }
    const result = cut(json === undefined ? "null" : json);
    message = { type: "result", id, json: result.text, cut: result.cut };
  } catch (error) {
    const text = cut(error instanceof Error ? (error.stack ?? error.message) : String(error));
    message = { type: "result", id, error: text.text, cut: text.cut };
  }
  await Promise.all([mark(writeOut, marker), mark(writeErr, marker)]);
  await send({ ...message, shellTruncated: running.truncated });
};

const reply = ({ callId, ok, value, message, code }) => {
  const waiting = pending.get(callId);
  if (waiting === undefined) return;
  pending.delete(callId);
  if (ok) waiting.resolve(value);
  else waiting.reject(new T3ToolError(waiting.tool, message, code));
};

// A socket, not fs.createReadStream: a pending fs read on fd 4 keeps process.exit from exiting.
const input = new net.Socket({ fd: 4, readable: true, writable: false });
const lines = readline.createInterface({ input, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "evaluate") void evaluate(message);
  else if (message.type === "reply") reply(message);
});
lines.on("close", () => process.exit(0));
`;
