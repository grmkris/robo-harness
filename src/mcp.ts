import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolSchemas, type ToolName } from "./shared/contracts";
import { callTool } from "./client";
const server = new McpServer({ name: "robo-harness", version: "0.1.0" });
for (const name of Object.keys(toolSchemas) as ToolName[]) {
  server.registerTool(
    "robot_" + name,
    {
      description:
        "Robo Harness " +
        name +
        ". Joint degrees, gripper percent, Cartesian meters. Motion requires an active lease.",
      inputSchema: toolSchemas[name],
    },
    async (input: Record<string, unknown>) => {
      try {
        const data = await callTool(name, input);
        if (name === "capture" && typeof data.base64 === "string")
          return {
            content: [
              {
                type: "image" as const,
                data: data.base64,
                mimeType: String(data.media_type),
              },
              {
                type: "text" as const,
                text: JSON.stringify({ ...data, base64: undefined }),
              },
            ],
          };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: e instanceof Error ? e.message : "Robot tool failed",
            },
          ],
        };
      }
    },
  );
}
await server.connect(new StdioServerTransport());
