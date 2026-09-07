// HTTP tailnet origins lack randomUUID; getRandomValues also works there.
export const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
const browserController = sessionStorage.getItem("robo-controller") ?? newId();
sessionStorage.setItem("robo-controller", browserController);
export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Robo-Browser": browserController,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "AUTH_REQUIRED"
        : (result.error ?? "Request failed")
    );
  }
  return result;
}
export const tool = (name: string, input: unknown = {}) =>
  api(`tool/${name}`, input);
export const label = (value: string) => value.replaceAll("_", " ");
export const time = (value: number) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
