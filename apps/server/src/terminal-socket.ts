import { TerminalClientMessage } from "@robo/domain";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { Schema } from "effect";

import { terminals } from "./terminal-runtime";

export interface TerminalSocketData {
  id: string;
  disconnect?: () => void;
  inputBytes?: number;
  inputWindow?: number;
}
const sendError = (
  socket: ServerWebSocket<TerminalSocketData>,
  message: string
) => {
  socket.send(JSON.stringify({ type: "error", message }));
  socket.close(1008, message);
};
export const terminalSocket: WebSocketHandler<TerminalSocketData> = {
  maxPayloadLength: 96 * 1024,
  // Accommodate a 128 KiB replay even when JSON escapes every byte.
  backpressureLimit: 1024 * 1024,
  closeOnBackpressureLimit: true,
  idleTimeout: 120,
  open: (socket) => {
    const disconnect = () => socket.close(4001, "Terminal attached elsewhere");
    socket.data.disconnect = disconnect;
    terminals.attach(
      socket.data.id,
      (event) => {
        if (socket.send(JSON.stringify(event)) === 0)
          socket.close(1013, "Reconnect to replay terminal output");
      },
      disconnect
    );
  },
  message: (socket, data) => {
    if (typeof data !== "string") {
      sendError(socket, "Terminal messages must be JSON text");
      return;
    }
    const now = Date.now();
    if (now - (socket.data.inputWindow ?? 0) > 1000) {
      socket.data.inputWindow = now;
      socket.data.inputBytes = 0;
    }
    socket.data.inputBytes = (socket.data.inputBytes ?? 0) + data.length;
    if (socket.data.inputBytes > 128 * 1024) {
      sendError(socket, "Terminal input rate exceeded");
      return;
    }
    try {
      const message = Schema.decodeUnknownSync(TerminalClientMessage, {
        onExcessProperty: "error",
      })(JSON.parse(data));
      if (!socket.data.disconnect) throw new Error("Terminal is not attached");
      terminals.receive(socket.data.id, message, socket.data.disconnect);
    } catch {
      sendError(socket, "Invalid message or terminal has exited");
    }
  },
  close: (socket) => {
    if (socket.data.disconnect)
      terminals.detach(socket.data.id, socket.data.disconnect);
  },
};
