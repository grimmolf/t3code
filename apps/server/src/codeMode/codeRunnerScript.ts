/**
 * Runs as `node -e` in its own process group. It reads the script from stdin and writes one
 * message to fd 3: `R` and the return value as JSON, or `E` and the error. No `${` below: this
 * is a template literal.
 */
export const CODE_RUNNER_SCRIPT = String.raw`"use strict";
delete process.env.ELECTRON_RUN_AS_NODE;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { createRequire } = require("node:module");
const windows = process.platform === "win32";

const quote = (value) => {
  if (Array.isArray(value)) return value.map(quote).join(" ");
  const text = String(value);
  return windows ? "'" + text.replace(/'/g, "''") + "'" : "'" + text.replace(/'/g, "'\\''") + "'";
};

const shellCommand = (command) =>
  windows
    ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]]
    : ["/bin/sh", ["-c", command]];

class ShellError extends Error {
  constructor(command, result) {
    super("Command exited with code " + result.exitCode + ": " + command + (result.stderr ? "\n" + result.stderr.slice(-4000) : ""));
    this.name = "ShellError";
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
  }
}

const $ = (strings, ...values) => {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    const tick = String.fromCharCode(96);
    throw new TypeError("$ is a template tag: write $" + tick + "command" + tick + ".");
  }
  const command = strings.raw.reduce(
    (text, part, index) => text + part + (index < values.length ? quote(values[index]) : ""),
    "",
  );
  const finished = new Promise((resolve) => {
    const [file, args] = shellCommand(command);
    const child = childProcess.spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolve({ stdout: "", stderr: error.message, exitCode: 127 }));
    child.on("close", (code, signal) =>
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 128 + (os.constants.signals[signal] ?? 0),
      }),
    );
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

const send = (message) =>
  new Promise((resolve, reject) => {
    const channel = fs.createWriteStream("", { fd: 3 });
    channel.on("error", reject);
    channel.end(message, resolve);
  });
const flush = (stream) => new Promise((resolve) => stream.write("", resolve));

(async () => {
  let code = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) code += chunk;
  let message;
  try {
    const AsyncFunction = (async () => {}).constructor;
    const script = new AsyncFunction("$", "edit", "require", "fs", code);
    const value = await script($, edit, createRequire(path.join(process.cwd(), "t3-code-run.js")), fs);
    let json;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      throw new Error("The return value cannot be encoded as JSON: " + error.message);
    }
    message = "R" + (json === undefined ? "null" : json);
  } catch (error) {
    message = "E" + (error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  await send(message);
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(0);
})();
`;
