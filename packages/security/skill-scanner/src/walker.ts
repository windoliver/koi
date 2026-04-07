/**
 * AST visitor utilities built on oxc-parser's Visitor.
 *
 * Provides lightweight scope tracking (variable alias resolution)
 * and helper predicates for common node patterns.
 */

import type {
  Argument,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  Expression,
  ForInStatement,
  IdentifierReference,
  ImportDeclaration,
  ImportExpression,
  MemberExpression,
  NewExpression,
  Program,
  StringLiteral,
  VariableDeclarator,
  VisitorObject,
} from "oxc-parser";
import { Visitor } from "oxc-parser";

// ---------------------------------------------------------------------------
// Scope tracker — resolves simple variable aliases
// ---------------------------------------------------------------------------

/**
 * Tracks `const x = eval` style aliases in a flat Map.
 * Not full scope analysis, but catches the most common evasion pattern.
 */
export interface ScopeTracker {
  readonly aliases: ReadonlyMap<string, string>;
  readonly resolve: (name: string) => string;
}

export function buildScopeTracker(program: Program): ScopeTracker {
  // Map is local to this function; push is the idiomatic way to build it
  const aliases = new Map<string, string>();

  const visitor: VisitorObject = {
    VariableDeclarator(node: VariableDeclarator) {
      if (
        node.id.type === "Identifier" &&
        node.init !== null &&
        node.init !== undefined &&
        node.init.type === "Identifier"
      ) {
        aliases.set(node.id.name, node.init.name);
      }
    },
  };

  new Visitor(visitor).visit(program);

  return {
    aliases,
    resolve(name: string): string {
      // let: iteratively resolved through alias chain
      let resolved = name;
      const seen = new Set<string>();
      while (aliases.has(resolved) && !seen.has(resolved)) {
        seen.add(resolved);
        resolved = aliases.get(resolved) ?? resolved;
      }
      return resolved;
    },
  };
}

// ---------------------------------------------------------------------------
// Typed visitor helpers
// ---------------------------------------------------------------------------

export interface ScanVisitorCallbacks {
  readonly onCallExpression?: (node: CallExpression) => void;
  readonly onNewExpression?: (node: NewExpression) => void;
  readonly onMemberExpression?: (node: MemberExpression) => void;
  readonly onIdentifier?: (node: IdentifierReference) => void;
  readonly onStringLiteral?: (node: StringLiteral) => void;
  readonly onImportExpression?: (node: ImportExpression) => void;
  readonly onImportDeclaration?: (node: ImportDeclaration) => void;
  readonly onBinaryExpression?: (node: BinaryExpression) => void;
  readonly onAssignmentExpression?: (node: AssignmentExpression) => void;
  readonly onVariableDeclarator?: (node: VariableDeclarator) => void;
  readonly onForInStatement?: (node: ForInStatement) => void;
}

export function visitAst(program: Program, callbacks: ScanVisitorCallbacks): void {
  const visitor: VisitorObject = {};

  if (callbacks.onCallExpression !== undefined) {
    visitor.CallExpression = callbacks.onCallExpression;
  }
  if (callbacks.onNewExpression !== undefined) {
    visitor.NewExpression = callbacks.onNewExpression;
  }
  if (callbacks.onMemberExpression !== undefined) {
    visitor.MemberExpression = callbacks.onMemberExpression;
  }
  if (callbacks.onStringLiteral !== undefined) {
    visitor.Literal = (node) => {
      // Narrow Literal union to StringLiteral via typeof check on value
      if ("value" in node && typeof node.value === "string") {
        callbacks.onStringLiteral?.(node);
      }
    };
  }
  if (callbacks.onIdentifier !== undefined) {
    // Visitor "Identifier" receives all identifier variants — structurally identical to IdentifierReference
    visitor.Identifier = (node) => {
      callbacks.onIdentifier?.(node as IdentifierReference);
    };
  }
  if (callbacks.onImportExpression !== undefined) {
    visitor.ImportExpression = callbacks.onImportExpression;
  }
  if (callbacks.onImportDeclaration !== undefined) {
    visitor.ImportDeclaration = callbacks.onImportDeclaration;
  }
  if (callbacks.onBinaryExpression !== undefined) {
    visitor.BinaryExpression = callbacks.onBinaryExpression;
  }
  if (callbacks.onAssignmentExpression !== undefined) {
    visitor.AssignmentExpression = callbacks.onAssignmentExpression;
  }
  if (callbacks.onVariableDeclarator !== undefined) {
    visitor.VariableDeclarator = callbacks.onVariableDeclarator;
  }
  if (callbacks.onForInStatement !== undefined) {
    visitor.ForInStatement = callbacks.onForInStatement;
  }

  new Visitor(visitor).visit(program);
}

// ---------------------------------------------------------------------------
// Node inspection helpers
// ---------------------------------------------------------------------------

export function getCalleeName(node: CallExpression): string | undefined {
  if (node.callee.type === "Identifier") {
    return node.callee.name;
  }
  return undefined;
}

export function getMemberPath(node: MemberExpression): string | undefined {
  // !computed narrows to StaticMemberExpression | PrivateFieldExpression — both have property.name
  if (!node.computed && node.object.type === "Identifier") {
    return `${node.object.name}.${node.property.name}`;
  }
  return undefined;
}

export function getStaticMemberProperty(node: MemberExpression): string | undefined {
  // !computed narrows to StaticMemberExpression | PrivateFieldExpression — both have property.name
  if (!node.computed) {
    return node.property.name;
  }
  return undefined;
}

export function getCalleeAsMemberPath(node: CallExpression): string | undefined {
  if (node.callee.type === "MemberExpression" && !node.callee.computed) {
    if (node.callee.object.type === "Identifier") {
      return `${node.callee.object.name}.${node.callee.property.name}`;
    }
  }
  return undefined;
}

export function isStringLiteralNode(node: Expression | Argument): node is StringLiteral {
  return node.type === "Literal" && "value" in node && typeof node.value === "string";
}

export function getStringValue(node: Expression | Argument): string | undefined {
  if (isStringLiteralNode(node)) {
    return node.value;
  }
  return undefined;
}

/**
 * Compute line/column from a byte offset + source text.
 */
export function offsetToLocation(
  source: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  // let: incremented per character to compute line/column from byte offset
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
