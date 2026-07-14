/**
 * Append-only, in-memory audit trail.
 *
 * Records are never mutated or deleted once written. Every governed path
 * (executed, queued, approved, rejected, denied) appends exactly one record. This
 * append-only shape is what lets an auditor reconstruct what the agent did.
 */
import { createIdSequence } from "./sequence.js";
import type { AuditRecord } from "./types.js";

export class AuditLog {
  private readonly records: AuditRecord[] = [];
  private readonly nextId = createIdSequence("au");

  /** Append a record. The caller supplies the facts; id and timestamp are stamped here. */
  record(entry: Omit<AuditRecord, "id" | "timestamp">): AuditRecord {
    const stored: AuditRecord = {
      id: this.nextId(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.records.push(stored);
    return stored;
  }

  /** The full trail, newest first, optionally narrowed to a single deal. */
  list(filter: { dealId?: string } = {}): AuditRecord[] {
    const newestFirst = [...this.records].reverse();
    if (filter.dealId === undefined) {
      return newestFirst;
    }
    return newestFirst.filter((record) => record.dealId === filter.dealId);
  }
}
