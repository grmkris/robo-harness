export async function callTool(name: string, input: unknown = {}) {
  const base = process.env["ROBO_URL"] ?? "http://127.0.0.1:8940";
  const token = process.env["ROBO_TOKEN"];
  const res = await fetch(`${base}/api/tool/${name}`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      "X-Robo-Controller": process.env["ROBO_CONTROLLER"] ?? "cli",
    },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(data["error"] ?? "Request failed"));
  }
  return data;
}
