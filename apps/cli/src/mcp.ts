// A thin MCP stdio bridge: newline-delimited JSON-RPC on stdin/stdout that
// forwards each tool call to a running coordinator over HTTP. The coordinator
// validates arguments and owns the leases; this process holds no state. The
// tool JSON Schema is derived from the same Effect Schema the coordinator
// decodes with, so the model is told exactly what the server will accept.
import { callTool, std, toolSchemas, type ToolName } from "@robo/protocol";

const names = Object.keys(toolSchemas) as ToolName[];
const READ_ONLY = new Set<ToolName>(["observe", "capture", "operation"]);
// MCP requires each tool's inputSchema to be an object schema. A tool with no
// arguments serialises to an `anyOf`, so it is normalised to an empty object.
function inputSchema(name: ToolName): Record<string, unknown> {
  const json = std(toolSchemas[name])["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  return json["type"] === "object"
    ? json
    : { type: "object", properties: {}, additionalProperties: false };
}
const tools = names.map((name) => ({
  name: `robot_${name}`,
  description: `Robo Harness ${name}. Joint degrees, gripper percent, Cartesian meters. Motion requires an active lease.`,
  inputSchema: inputSchema(name),
  annotations: { readOnlyHint: READ_ONLY.has(name) },
}));

interface Message {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(name: ToolName, data: Record<string, unknown>) {
  if (name === "capture" && typeof data["base64"] === "string") {
    return {
      content: [
        {
          type: "image",
          data: data["base64"],
          mimeType: String(data["media_type"]),
        },
        { type: "text", text: JSON.stringify({ ...data, base64: undefined }) },
      ],
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function handle(message: Message): Promise<void> {
  const { id, method, params } = message;
  // A notification (no id) never moves the arm and needs no reply.
  if (id === undefined) {
    return;
  }
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          (params?.["protocolVersion"] as string | undefined) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "robo-harness", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const rawName = String(params?.["name"] ?? "").replace(/^robot_/u, "");
    if (!names.includes(rawName as ToolName)) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32_602, message: "Unknown tool" },
      });
      return;
    }
    const name = rawName as ToolName;
    try {
      const data = await callTool(
        name,
        (params?.["arguments"] as Record<string, unknown>) ?? {}
      );
      send({ jsonrpc: "2.0", id, result: toolResult(name, data) });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Robot tool failed",
            },
          ],
        },
      });
    }
    return;
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32_601, message: "Method not found" },
  });
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        await handle(JSON.parse(line) as Message);
      } catch {
        // Ignore a malformed line; the client will retry with a valid one.
      }
    }
    index = buffer.indexOf("\n");
  }
}
