/**
 * Shared content-block utilities for pi ↔ Koi conversion.
 */

/**
 * Look up the toolCall at a raw content block index.
 *
 * pi-ai's contentIndex is the Anthropic content block index (0-based), which includes
 * thinking blocks at lower indices. Counting only toolCall items would give the wrong
 * result when thinking blocks precede the tool_use block (e.g. thinking=0, tool_use=1).
 */
export function findToolCallAtContentIndex(
  content: readonly { readonly type: string }[],
  contentIndex: number,
):
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments?: Record<string, unknown>;
    }
  | undefined {
  const item = content[contentIndex];
  if (item !== undefined && item.type === "toolCall") {
    return item as {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments?: Record<string, unknown>;
    };
  }
  return undefined;
}
