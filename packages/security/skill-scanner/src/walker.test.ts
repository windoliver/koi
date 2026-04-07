import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import {
  buildScopeTracker,
  getCalleeAsMemberPath,
  getCalleeName,
  getStringValue,
  offsetToLocation,
  visitAst,
} from "./walker.js";

function parse(code: string) {
  return parseSync("input.ts", code, { sourceType: "module" }).program;
}

describe("buildScopeTracker", () => {
  test("tracks simple variable aliases", () => {
    const program = parse('const e = eval; e("code");');
    const scope = buildScopeTracker(program);
    expect(scope.resolve("e")).toBe("eval");
  });

  test("resolves chained aliases", () => {
    const program = parse("const a = eval;\nconst b = a;\nconst c = b;");
    const scope = buildScopeTracker(program);
    expect(scope.resolve("c")).toBe("eval");
  });

  test("returns original name for non-aliased identifiers", () => {
    const program = parse("const x = 1;");
    const scope = buildScopeTracker(program);
    expect(scope.resolve("foo")).toBe("foo");
  });

  test("handles circular aliases without infinite loop", () => {
    const program = parse("const a = b;\nconst b = a;");
    const scope = buildScopeTracker(program);
    const result = scope.resolve("a");
    expect(typeof result).toBe("string");
  });
});

describe("visitAst", () => {
  test("visits CallExpression nodes", () => {
    const program = parse("eval('code');");
    const calls: string[] = [];
    visitAst(program, {
      onCallExpression(node) {
        const name = getCalleeName(node);
        if (name !== undefined) calls.push(name);
      },
    });
    expect(calls).toEqual(["eval"]);
  });

  test("visits MemberExpression nodes", () => {
    const program = parse("process.env.SECRET;");
    const members: string[] = [];
    visitAst(program, {
      onMemberExpression(node) {
        if (!node.computed && node.object.type === "Identifier") {
          members.push(node.object.name);
        }
      },
    });
    expect(members.length).toBeGreaterThan(0);
  });

  test("visits string literals", () => {
    const program = parse('const x = "hello";');
    const strings: string[] = [];
    visitAst(program, {
      onStringLiteral(node) {
        strings.push(node.value);
      },
    });
    expect(strings).toContain("hello");
  });

  test("visits ImportExpression nodes", () => {
    const program = parse('import("child_process");');
    const imports: string[] = [];
    visitAst(program, {
      onImportExpression(node) {
        const val = getStringValue(node.source);
        if (val !== undefined) imports.push(val);
      },
    });
    expect(imports).toEqual(["child_process"]);
  });
});

describe("getCalleeAsMemberPath", () => {
  test("resolves static member call path", () => {
    const program = parse("child_process.exec('cmd');");
    const paths: string[] = [];
    visitAst(program, {
      onCallExpression(node) {
        const path = getCalleeAsMemberPath(node);
        if (path !== undefined) paths.push(path);
      },
    });
    expect(paths).toEqual(["child_process.exec"]);
  });

  test("resolves bracket-notation string-literal member call path", () => {
    const program = parse('child_process["execSync"]("cmd");');
    const paths: string[] = [];
    visitAst(program, {
      onCallExpression(node) {
        const path = getCalleeAsMemberPath(node);
        if (path !== undefined) paths.push(path);
      },
    });
    expect(paths).toEqual(["child_process.execSync"]);
  });

  test("returns undefined for bracket-notation with non-literal expression", () => {
    const program = parse("obj[variable]();");
    const paths: string[] = [];
    visitAst(program, {
      onCallExpression(node) {
        const path = getCalleeAsMemberPath(node);
        if (path !== undefined) paths.push(path);
      },
    });
    expect(paths).toEqual([]);
  });

  test("flattens chained member access: globalThis.process.binding()", () => {
    const program = parse("globalThis.process.binding('natives');");
    const paths: string[] = [];
    visitAst(program, {
      onCallExpression(node) {
        const path = getCalleeAsMemberPath(node);
        if (path !== undefined) paths.push(path);
      },
    });
    expect(paths).toEqual(["globalThis.process.binding"]);
  });

  test('flattens mixed static/computed chain: globalThis.child_process["execSync"]()', () => {
    const program = parse('globalThis.child_process["execSync"]("cmd");');
    const paths: string[] = [];
    visitAst(program, {
      onCallExpression(node) {
        const path = getCalleeAsMemberPath(node);
        if (path !== undefined) paths.push(path);
      },
    });
    expect(paths).toEqual(["globalThis.child_process.execSync"]);
  });

  test("resolves template-literal computed key: child_process[`execSync`]()", () => {
    const program = parse("child_process[`execSync`]('cmd');");
    const paths: string[] = [];
    visitAst(program, {
      onCallExpression(node) {
        const path = getCalleeAsMemberPath(node);
        if (path !== undefined) paths.push(path);
      },
    });
    expect(paths).toEqual(["child_process.execSync"]);
  });
});

describe("offsetToLocation", () => {
  test("returns line 1 column 1 for offset 0", () => {
    expect(offsetToLocation("abc", 0)).toEqual({ line: 1, column: 1 });
  });

  test("tracks newlines", () => {
    expect(offsetToLocation("abc\ndef", 4)).toEqual({ line: 2, column: 1 });
  });

  test("handles empty source", () => {
    expect(offsetToLocation("", 0)).toEqual({ line: 1, column: 1 });
  });
});
