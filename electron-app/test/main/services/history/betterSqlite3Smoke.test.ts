import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("better-sqlite3 native module", () => {
  it("loads the compiled addon and opens an in-memory database", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
      db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
      const row = db.prepare("SELECT v FROM t WHERE id = 1").get() as { v: string };
      expect(row.v).toBe("hello");
    } finally {
      db.close();
    }
  });

  it("enforces foreign keys once the pragma is set (proves the build is not a stub)", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");
      db.exec("CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id))");
      const insertOrphan = () => db.prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)").run("c1", "nope");
      expect(insertOrphan).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });
});
