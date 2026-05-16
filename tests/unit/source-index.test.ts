import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

describe("legal source index", () => {
  test("downloaded source hashes match index", () => {
    const index = JSON.parse(readFileSync("sources/downloaded/index.json", "utf8")) as Array<{ localPath: string; sha256: string; bytes: number }>;
    expect(index.length).toBeGreaterThanOrEqual(5);
    for (const source of index) {
      expect(existsSync(source.localPath)).toBe(true);
      const body = readFileSync(source.localPath);
      expect(body.byteLength).toBe(source.bytes);
      expect(createHash("sha256").update(body).digest("hex")).toBe(source.sha256);
    }
  });
});
