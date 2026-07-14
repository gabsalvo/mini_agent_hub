/**
 * In-memory FIFO queue of high-risk actions awaiting approval.
 *
 * Items are never removed — they transition status (pending → approved | rejected)
 * and stay in the queue's history. That, plus the monotonic id, is what makes
 * double-approval safe: only a still-"pending" action can be resolved, so a second
 * approval of the same id is a no-op rather than a second write.
 */
import { createIdSequence } from "./sequence.js";
import type { Deal } from "./crm.js";
import type { DealChange, PendingAction } from "./types.js";

export class ApprovalQueue {
  private readonly actions: PendingAction[] = [];
  private readonly nextId = createIdSequence("pa");

  /** Enqueue a proposed deal update. `snapshot` must already be a COPY of the deal. */
  enqueueDealUpdate(input: {
    dealId: string;
    changes: DealChange;
    snapshot: Deal;
    proposedBy: string;
  }): PendingAction {
    const action: PendingAction = {
      id: this.nextId(),
      type: "update_deal",
      dealId: input.dealId,
      changes: input.changes,
      snapshot: input.snapshot,
      proposedBy: input.proposedBy,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.actions.push(action);
    return action;
  }

  getById(id: string): PendingAction | undefined {
    return this.actions.find((action) => action.id === id);
  }

  /** Still-pending actions in FIFO (oldest-first) order. */
  listPending(): PendingAction[] {
    return this.actions.filter((action) => action.status === "pending");
  }

  /**
   * Move a pending action to a final state. Returns the updated action, or
   * undefined if it is unknown OR already resolved. The caller treats undefined as
   * a no-op — this is the double-approval / double-reject guard.
   */
  resolve(
    id: string,
    status: "approved" | "rejected",
    resolvedBy: string,
  ): PendingAction | undefined {
    const action = this.getById(id);
    if (action === undefined || action.status !== "pending") {
      return undefined;
    }
    action.status = status;
    action.resolvedBy = resolvedBy;
    action.resolvedAt = new Date().toISOString();
    return action;
  }
}
