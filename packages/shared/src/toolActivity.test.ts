import { describe, expect, it } from "vite-plus/test";

import {
  classifyToolActivity,
  dynamicToolSurface,
  dynamicToolTitle,
  isJavaScriptReplTool,
  mergeToolActivityData,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("classifies from kind and toolName without sniffing titles", () => {
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { toolName: "Grep" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    for (const toolName of ["github.read_file", "mongodb.find", "mcp__github__read_file"]) {
      expect(classifyToolActivity({ data: { toolName } })).toBe("other");
    }
    expect(classifyToolActivity({ title: "Find", data: {} })).toBe("other");
  });

  it("classifies Claude search tools ahead of their broad file-read request kind", () => {
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(classifyToolActivity({ requestKind: "file-read", data: { toolName } })).toBe("search");
    }
    expect(classifyToolActivity({ requestKind: "file-read", data: { toolName: "Read" } })).toBe(
      "read",
    );
  });

  it("keeps the previous rawInput when a later update is empty and replaces it otherwise", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { startLine: 4 } });
  });

  it("recognizes computer-use REPL calls before result metadata exists", () => {
    expect(dynamicToolSurface("cua_repl.js", {})).toBe("computer");
    for (const name of ["node_repl.js", "js"]) {
      expect(dynamicToolSurface(name, { code: "await sky.get_app_state(app);" })).toBe("computer");
      expect(dynamicToolSurface(name, { code: "const sky = await import('@oai/sky');" })).toBe(
        "computer",
      );
      expect(dynamicToolSurface(name, { code: "await fs.readFile(path);" })).toBeUndefined();
    }
    expect(dynamicToolSurface("github.js", { code: "await sky.click(app);" })).toBeUndefined();
  });

  it("presents T3's code tools as JavaScript rows under the names providers report", () => {
    const titles = {
      t3_code_run: "Run JavaScript",
      t3_code_poll: "Check JavaScript",
      t3_code_reset: "Reset JavaScript",
    };
    for (const [tool, title] of Object.entries(titles)) {
      for (const name of [
        `mcp__t3-code__${tool}`,
        `t3-code.${tool}`,
        `t3-code-direct.${tool}`,
        `t3-code · ${tool}`,
        `t3-code-thread_opencode2-adapter_${tool}`,
      ]) {
        expect(isJavaScriptReplTool(name), name).toBe(true);
        expect(dynamicToolTitle(name, {}), name).toBe(title);
        expect(dynamicToolSurface(name, { code: "await sky.click(app);" })).toBeUndefined();
      }
      expect(isJavaScriptReplTool(`mcp__github__${tool}`)).toBe(false);
    }
    expect(
      dynamicToolTitle("t3-code.t3_code_run", { code: "return 1", title: "Rename helpers" }),
    ).toBe("Rename helpers");
  });
});
