// Patchbay MCP server (STDIO). Milestone 0: exposes the read-only patchbay_doctor tool.
// Durable execution tools (delegate/verify/apply/...) arrive in later milestones.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runDoctor, formatDoctor } from "../doctor.ts";
import { PATCHBAY_VERSION } from "../version.ts";

const server = new McpServer({ name: "patchbay", version: PATCHBAY_VERSION });

server.registerTool(
  "patchbay_doctor",
  {
    title: "Patchbay doctor",
    description:
      "Read-only health and compatibility check for runtimes, provider profiles, sandbox, and the target repository. Never reveals credential values.",
    inputSchema: {
      path: z.string().optional().describe("Repository path to inspect. Defaults to the server's working directory."),
    },
  },
  async ({ path }) => {
    const report = runDoctor({ path });
    return { content: [{ type: "text", text: formatDoctor(report) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
