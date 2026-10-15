export interface DocumentSnapshot {
  readonly bytes: Uint8Array;
  readonly currentPage: number;
  readonly selected: readonly number[];
  readonly selectedAnnotation: string | null;
}

interface HistoryEntry {
  snapshot: DocumentSnapshot;
  label: string;
}

export type HistoryDirection = "undo" | "redo";

/** A document timeline bounded by edit count and retained PDF bytes, excluding the current document. */
export class DocumentHistory {
  private entries: HistoryEntry[] = [];
  private cursor = -1;

  /** Use smaller limits in tests; production retains at most 50 edits and 256 MiB of history. */
  constructor(
    private readonly maxEdits = 50,
    private readonly maxBytes = 256 * 1024 * 1024,
  ) {
    if (!Number.isInteger(maxEdits) || maxEdits < 1 || !Number.isFinite(maxBytes) || maxBytes < 0)
      throw new Error(
        "History limits must be a positive edit count and a nonnegative byte budget.",
      );
  }

  /** Replace the timeline only after a new document has successfully opened. */
  reset(snapshot: DocumentSnapshot): void {
    this.entries = [{ snapshot, label: "" }];
    this.cursor = 0;
  }

  /** Return a neighboring snapshot and action label without changing the timeline. */
  peek(direction: HistoryDirection): HistoryEntry | undefined {
    if (this.cursor < 0) return undefined;
    if (direction === "undo") {
      if (this.cursor === 0) return undefined;
      return {
        snapshot: this.entries[this.cursor - 1].snapshot,
        label: this.entries[this.cursor].label,
      };
    }
    return this.entries[this.cursor + 1];
  }

  /** Record a successful edit, preserving pre-edit selection and discarding any abandoned redo branch. */
  record(before: DocumentSnapshot, after: DocumentSnapshot, label: string): void {
    if (this.cursor < 0) throw new Error("Open a document before recording history.");
    this.entries[this.cursor].snapshot = before;
    this.entries.splice(this.cursor + 1);
    this.entries.push({ snapshot: after, label });
    this.cursor++;
    this.trim();
  }

  /** Advance only after restoration succeeds; retain the latest view context for the inverse action. */
  advance(direction: HistoryDirection, current: DocumentSnapshot): void {
    if (!this.peek(direction)) throw new Error(`No document edit is available to ${direction}.`);
    this.entries[this.cursor].snapshot = current;
    this.cursor += direction === "undo" ? -1 : 1;
    this.trim();
  }

  /** Evict oldest undo states first, then distant redo states, never the current document. */
  private trim(): void {
    while (
      this.entries.length - 1 > this.maxEdits ||
      this.entries.reduce(
        (bytes, entry, index) =>
          bytes + (index === this.cursor ? 0 : entry.snapshot.bytes.byteLength),
        0,
      ) > this.maxBytes
    ) {
      if (this.cursor > 0) {
        this.entries.shift();
        this.cursor--;
      } else {
        this.entries.pop();
      }
    }
  }
}
