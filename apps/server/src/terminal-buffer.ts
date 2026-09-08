// Preserve UTF-8 across PTY chunks and redact the capability even when a token
// is split between reads. Hold only a suffix that could begin the token, so
// ordinary prompts render immediately.
export const terminalOutput = (token: string) => {
  const decoder = new TextDecoder();
  let pending = "";
  return (bytes: Uint8Array): string => {
    const text = (pending + decoder.decode(bytes, { stream: true })).replaceAll(
      token,
      "[program token]"
    );
    let length = Math.min(token.length - 1, text.length);
    while (length > 0 && !text.endsWith(token.slice(0, length))) length -= 1;
    pending = length > 0 ? text.slice(-length) : "";
    return length > 0 ? text.slice(0, -length) : text;
  };
};
export const replayBuffer = (maxBytes = 128 * 1024) => {
  const chunks: string[] = [];
  let size = 0;
  const encoder = new TextEncoder();
  return {
    append: (data: string) => {
      // A single read can exceed the ring: retain complete Unicode codepoints.
      let bounded = data;
      if (encoder.encode(bounded).byteLength > maxBytes) {
        const characters: string[] = [];
        for (const character of bounded) characters.push(character);
        bounded = characters.slice(-Math.floor(maxBytes / 4)).join("");
      }
      chunks.push(bounded);
      size += encoder.encode(bounded).byteLength;
      while (size > maxBytes && chunks.length > 1) {
        size -= encoder.encode(chunks.shift() ?? "").byteLength;
      }
    },
    read: () => chunks.join(""),
  };
};
