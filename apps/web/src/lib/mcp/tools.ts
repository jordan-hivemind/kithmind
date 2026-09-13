export const MCP_TOOL_NAMES = {
  ingestUrl: "ingest_url",
  queryRecords: "query_records",
  searchDocuments: "search_documents",
  getDocument: "get_document",
  listSources: "list_sources",
  listInventory: "list_inventory",
  listReviewQueue: "list_review_queue",
  listSpaces: "list_spaces",
  searchFacts: "search_facts",
  rememberFact: "remember_fact",
  searchThoughts: "search_thoughts",
  recallContext: "recall_context",
  browseRecent: "browse_recent",
  getThoughts: "get_thoughts",
  timelineThoughts: "timeline_thoughts",
  getStats: "get_stats",
  captureThought: "capture_thought",
} as const;

export const MCP_TOOL_NAME_LIST = Object.values(MCP_TOOL_NAMES);
