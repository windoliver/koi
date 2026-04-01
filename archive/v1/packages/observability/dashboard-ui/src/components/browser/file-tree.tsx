/**
 * FileTree — root component for the file tree sidebar.
 *
 * Delegates to VirtualFileTree which uses @tanstack/react-virtual
 * for efficient rendering of large file trees.
 */

import { VirtualFileTree } from "./virtual-file-tree.js";

export function FileTree(): React.ReactElement {
  return <VirtualFileTree />;
}
