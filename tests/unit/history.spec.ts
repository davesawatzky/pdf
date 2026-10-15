import { describe, expect, it } from "vite-plus/test";
import { DocumentHistory } from "../../src/lib/history";
import type { DocumentSnapshot } from "../../src/lib/history";

/** Create small distinguishable PDF-state stand-ins for exact history-budget tests. */
function snapshot(value: number, size = 4): DocumentSnapshot {
  return {
    bytes: new Uint8Array(size).fill(value),
    currentPage: 1,
    selected: [],
    selectedAnnotation: null,
  };
}

describe("bounded document history", () => {
  it("starts empty and refuses recording or advancing an uninitialized timeline", () => {
    const history = new DocumentHistory();
    expect(history.peek("undo")).toBeUndefined();
    expect(history.peek("redo")).toBeUndefined();
    expect(() => history.record(snapshot(0), snapshot(1), "Edit")).toThrow("Open a document");
    expect(() => history.advance("undo", snapshot(0))).toThrow("No document edit");
  });

  it("peeks without advancing, preserves action labels, and replaces redo branches only on commit", () => {
    const history = new DocumentHistory();
    const original = snapshot(0),
      first = snapshot(1),
      second = snapshot(2),
      branch = snapshot(3);
    history.reset(original);
    history.record(original, first, "First");
    history.record(first, second, "Second");
    expect(history.peek("undo")).toEqual({ snapshot: first, label: "Second" });
    expect(history.peek("undo")).toEqual({ snapshot: first, label: "Second" });
    history.advance("undo", { ...second, currentPage: 3, selected: [2] });
    expect(history.peek("undo")).toEqual({ snapshot: original, label: "First" });
    expect(history.peek("redo")).toEqual({
      snapshot: { ...second, currentPage: 3, selected: [2] },
      label: "Second",
    });
    history.advance("redo", first);
    history.advance("undo", second);
    history.record(first, branch, "Branch");
    expect(history.peek("redo")).toBeUndefined();
    expect(history.peek("undo")).toEqual({ snapshot: first, label: "Branch" });
    history.reset(snapshot(9));
    expect(history.peek("undo")).toBeUndefined();
    expect(history.peek("redo")).toBeUndefined();
  });

  it("retains exactly 50 production-limit edits, evicting only the oldest snapshots", () => {
    const history = new DocumentHistory();
    let current = snapshot(0);
    history.reset(current);
    for (let index = 1; index <= 55; index++) {
      const next = snapshot(index);
      history.record(current, next, `Edit ${index}`);
      current = next;
    }
    for (let index = 55; index > 5; index--) {
      const step = history.peek("undo");
      expect(step?.label).toBe(`Edit ${index}`);
      history.advance("undo", current);
      if (!step) throw new Error("Expected retained history");
      current = step.snapshot;
    }
    expect(current.bytes[0]).toBe(5);
    expect(history.peek("undo")).toBeUndefined();
    for (let index = 6; index <= 55; index++) {
      const step = history.peek("redo");
      expect(step?.label).toBe(`Edit ${index}`);
      history.advance("redo", current);
      if (!step) throw new Error("Expected redo history");
      current = step.snapshot;
    }
    expect(history.peek("redo")).toBeUndefined();
  });

  it("enforces the byte budget at equality and excludes the current document's bytes", () => {
    const history = new DocumentHistory(50, 8);
    const original = snapshot(0),
      first = snapshot(1),
      second = snapshot(2, 100);
    history.reset(original);
    history.record(original, first, "First");
    history.record(first, second, "Second");
    expect(history.peek("undo")?.snapshot).toBe(first);
    history.advance("undo", second);
    expect(history.peek("undo")).toBeUndefined();
    expect(history.peek("redo")).toBeUndefined();
    // The 100-byte redo state cannot fit, even though it was allowed as the current document.
    history.record(first, snapshot(3), "Third");
    expect(history.peek("undo")?.snapshot).toBe(first);
  });

  it("retains the exact byte limit and evicts one oldest state when the limit is exceeded", () => {
    const history = new DocumentHistory(50, 8);
    const original = snapshot(0),
      first = snapshot(1),
      second = snapshot(2),
      third = snapshot(3);
    history.reset(original);
    history.record(original, first, "First");
    history.record(first, second, "Second");
    history.advance("undo", second);
    expect(history.peek("undo")?.snapshot).toBe(original);
    history.advance("redo", first);
    history.record(second, third, "Third");
    history.advance("undo", third);
    history.advance("undo", second);
    expect(history.peek("undo")).toBeUndefined();
    expect(history.peek("redo")?.snapshot).toBe(second);
  });

  it("drops a single oversized past snapshot and can subsequently record smaller states", () => {
    const history = new DocumentHistory(50, 4);
    const large = snapshot(0, 5),
      small = snapshot(1);
    history.reset(large);
    history.record(large, small, "Shrink");
    expect(history.peek("undo")).toBeUndefined();
    history.record(small, snapshot(2), "Edit");
    expect(history.peek("undo")?.snapshot).toBe(small);
  });

  it("supports a zero-byte budget without evicting the current state", () => {
    const history = new DocumentHistory(1, 0);
    const first = snapshot(0);
    history.reset(first);
    history.record(first, snapshot(1), "Edit");
    expect(history.peek("undo")).toBeUndefined();
    expect(history.peek("redo")).toBeUndefined();
  });

  it.each([
    [0, 1],
    [1.5, 1],
    [1, -1],
    [1, Infinity],
    [NaN, 1],
  ])("rejects invalid limits %s / %s", (edits, bytes) =>
    expect(() => new DocumentHistory(edits, bytes)).toThrow("History limits"),
  );
});
