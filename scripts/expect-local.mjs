// Keep deterministic Expect CLI checks local; disable unrelated external
// update requests made by the command-line wrapper.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return Promise.reject(
      new Error("External CLI fetch disabled for local validation"),
    );
  }
  return nativeFetch(input, init);
};
