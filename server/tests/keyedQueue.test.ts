import { describe, expect, it } from "vitest";
import { runExclusive } from "../src/lib/keyedQueue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runExclusive", () => {
  it("runs calls with the same key one at a time, in arrival order", async () => {
    const events: string[] = [];
    const job = (name: string, ms: number) => () =>
      (async () => {
        events.push(`start ${name}`);
        await sleep(ms);
        events.push(`end ${name}`);
        return name;
      })();
    const results = await Promise.all([
      runExclusive("k", job("a", 30)),
      runExclusive("k", job("b", 5)),
      runExclusive("k", job("c", 1)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("does not make different keys wait for each other", async () => {
    let slowDone = false;
    const slow = runExclusive("slow", async () => {
      await sleep(40);
      slowDone = true;
    });
    await runExclusive("fast", async () => undefined);
    expect(slowDone).toBe(false);
    await slow;
  });

  it("keeps going after a call fails, and passes the error to its own caller only", async () => {
    const failing = runExclusive("k", async () => {
      throw new Error("boom");
    });
    const next = runExclusive("k", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
