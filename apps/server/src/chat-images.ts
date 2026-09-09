import type { Frame } from "@robo/domain";

import { db } from "./store";

/** Keep exact camera pixels outside event/transcript JSON. Reopening a chat
 * must never substitute today's live camera for a historical observation. */
export const saveChatImage = (sessionId: string, frame: Frame): string => {
  const id = crypto.randomUUID();
  db.query(
    "INSERT INTO chat_images(id,session_id,frame_id,media_type,bytes) VALUES(?,?,?,?,?)"
  ).run(
    id,
    sessionId,
    frame.id,
    frame.media_type,
    Buffer.from(frame.base64, "base64")
  );
  return id;
};

export const chatImage = (id: string) =>
  db
    .query<
      { frame_id: string; media_type: string; bytes: Uint8Array },
      [string]
    >("SELECT frame_id,media_type,bytes FROM chat_images WHERE id=?")
    .get(id);
