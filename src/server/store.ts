import { Database } from "bun:sqlite";
import { config } from "./config";
import type { AppEvent } from "../shared/contracts";
export const db = new Database(config.dataDir + "/harness.sqlite", {
  create: true,
});
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
db.exec(`
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,messages TEXT NOT NULL DEFAULT '[]',created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,label TEXT NOT NULL,state TEXT NOT NULL,path TEXT NOT NULL,created INTEGER NOT NULL,finished INTEGER,frames INTEGER NOT NULL DEFAULT 0,error TEXT);
 CREATE TABLE IF NOT EXISTS budgets(id INTEGER PRIMARY KEY CHECK(id=1),limit_usd REAL NOT NULL,spent_usd REAL NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS perception(id TEXT PRIMARY KEY,state TEXT NOT NULL,source TEXT NOT NULL,result TEXT,error TEXT,created INTEGER NOT NULL);
`);
db.run(
  "UPDATE recordings SET state='incomplete',error='Application restarted before finalization' WHERE state='recording'",
);
const listeners = new Set<(event: AppEvent) => void>();
export function emit(type: string, data: Record<string, unknown>) {
  const time = Date.now();
  const result = db
    .query("INSERT INTO events(time,type,data) VALUES(?,?,?)")
    .run(time, type, JSON.stringify(data));
  const event = { id: Number(result.lastInsertRowid), time, type, data };
  for (const fn of listeners) fn(event);
  return event;
}
export function events(after = 0, limit = 200): AppEvent[] {
  return (
    db
      .query("SELECT * FROM events WHERE id>? ORDER BY id DESC LIMIT ?")
      .all(after, limit) as Array<{
      id: number;
      time: number;
      type: string;
      data: string;
    }>
  )
    .reverse()
    .map((e) => ({ ...e, data: JSON.parse(e.data) }));
}
export function subscribe(fn: (event: AppEvent) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
