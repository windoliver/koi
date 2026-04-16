/**
 * Minimal stdio MCP echo server for E2E testing.
 * Used to reproduce/verify #1852: stdio server must show "connected" not "needs-auth".
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes back the input message.",
      inputSchema: {
        type: "object" as const,
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (req) => ({
  content: [
    {
      type: "text" as const,
      text: String((req.params.arguments as { message?: unknown })?.message ?? ""),
    },
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
