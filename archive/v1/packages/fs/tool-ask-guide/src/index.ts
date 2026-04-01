/**
 * @koi/tool-ask-guide — Guide agent knowledge retrieval tool (Layer 2).
 *
 * Provides a thin tool that queries knowledge sources within a token budget,
 * preventing context window pollution from raw search results.
 */

export { createAskGuideTool } from "./ask-guide-tool.js";
export { createAskGuideProvider } from "./provider.js";
export { createRetrieverSearch } from "./search-adapter.js";
export type { AskGuideConfig, GuideSearchResult } from "./types.js";
export {
  ASK_GUIDE_TOOL_DESCRIPTOR,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MAX_TOKENS,
} from "./types.js";
