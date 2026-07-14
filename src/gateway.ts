/**
 * The Gateway — the single choke point every tool call passes through.
 *
 * It owns the three guarantees the challenge asks for:
 *   1. permissions are enforced server-side (no tool can skip the check),
 *   2. low-risk writes execute immediately while high-risk writes are queued, and
 *   3. every write, approval and denial lands in the audit log.
 *
 * The tools in server.ts are thin wrappers that translate MCP arguments into
 * Gateway calls and serialize the result — all the governance logic lives here.
 */
import type { CrmPort } from "./crm-port.js";
import type { AuditLog } from "./audit-log.js";
import type { ApprovalQueue } from "./approval-queue.js";
import { authorize } from "./permissions.js";
import type { Deal, User } from "./crm.js";
import type { Capability, DealChange, FieldConflict, GatewayResult } from "./types.js";

export class Gateway {
  constructor(
    private readonly crm: CrmPort,
    private readonly queue: ApprovalQueue,
    private readonly audit: AuditLog,
  ) {}

  // ── Reads: allowed to any authenticated user, and not audited ────────────
  // An auditor reconstructs what the agent *changed*, not what anyone *read*,
  // so reads stay out of the trail by design.

  searchContacts(actorId: string, query: string): GatewayResult {
    if (!this.requireReader(actorId)) return unauthenticated(actorId);
    return ok("Contacts matching your search.", this.crm.searchContacts(query));
  }

  listDeals(actorId: string): GatewayResult {
    if (!this.requireReader(actorId)) return unauthenticated(actorId);
    return ok("All deals.", this.crm.listDeals());
  }

  viewDeal(actorId: string, dealId: string): GatewayResult {
    if (!this.requireReader(actorId)) return unauthenticated(actorId);
    const deal = this.crm.getDeal(dealId);
    if (!deal) return fail(`Deal '${dealId}' not found.`);
    return ok(`Deal ${dealId}.`, deal);
  }

  listDealActivities(actorId: string, dealId: string): GatewayResult {
    if (!this.requireReader(actorId)) return unauthenticated(actorId);
    return ok(`Activities for deal ${dealId}.`, this.crm.listActivities(dealId));
  }

  viewPendingQueue(actorId: string): GatewayResult {
    if (!this.requireReader(actorId)) return unauthenticated(actorId);
    return ok("Pending actions awaiting approval.", this.queue.listPending());
  }

  viewAuditLog(actorId: string, dealId?: string): GatewayResult {
    if (!this.requireReader(actorId)) return unauthenticated(actorId);
    return ok("Audit log (newest first).", this.audit.list({ dealId }));
  }

  // ── Low-risk write: executes immediately ─────────────────────────────────

  logActivity(actorId: string, dealId: string, note: string): GatewayResult {
    const action = "log_activity";
    const user = this.authorizeWriter(actorId, action, "write_low_risk", dealId);
    if (!user) return denied(actorId, "log activities");

    if (!this.crm.getDeal(dealId)) {
      this.audit.record({ actor: user.id, action, outcome: "rejected", dealId, reason: `Deal '${dealId}' not found.` });
      return fail(`Deal '${dealId}' not found.`);
    }

    const activity = this.crm.logActivity(dealId, user.id, note);
    this.audit.record({ actor: user.id, action, outcome: "executed", dealId, after: activity });
    return ok(`Activity logged on deal ${dealId}.`, activity);
  }

  // ── High-risk write: queued for approval, does NOT apply yet ──────────────

  proposeDealUpdate(actorId: string, dealId: string, changes: DealChange): GatewayResult {
    const action = "update_deal";
    const user = this.authorizeWriter(actorId, action, "write_high_risk", dealId);
    if (!user) return denied(actorId, "update deals");

    const deal = this.crm.getDeal(dealId);
    if (!deal) {
      this.audit.record({ actor: user.id, action, outcome: "rejected", dealId, reason: `Deal '${dealId}' not found.` });
      return fail(`Deal '${dealId}' not found.`);
    }

    // Freeze the state the approver will be judged against (crm.getDeal returns a live ref).
    const snapshot = cloneDeal(deal);
    const pending = this.queue.enqueueDealUpdate({ dealId, changes, snapshot, proposedBy: user.id });
    // A queued record captures the current deal (`before`) and the proposed diff
    // (`changes`). It deliberately has NO `after`: nothing is applied until approval,
    // so showing a projected "after" here would misrepresent what actually happened.
    this.audit.record({
      actor: user.id,
      action,
      outcome: "queued",
      dealId,
      before: snapshot,
      changes,
      pendingActionId: pending.id,
    });
    return ok(
      `High-risk change queued as ${pending.id}. It applies only after an approver releases it.`,
      pending,
    );
  }

  // ── Approvals: apply the change, but re-check freshness first ─────────────

  approveAction(actorId: string, pendingActionId: string): GatewayResult {
    const action = "approve_pending_action";
    const user = this.authorizeWriter(actorId, action, "approve");
    if (!user) return denied(actorId, "approve actions");

    const pending = this.queue.getById(pendingActionId);
    if (!pending) {
      this.audit.record({ actor: user.id, action, outcome: "denied", reason: `Unknown pending action '${pendingActionId}'.`, pendingActionId });
      return fail(`No pending action with id '${pendingActionId}'.`);
    }
    if (pending.status !== "pending") {
      // Double-approval guard: already resolved, so nothing changes — but log the attempt.
      this.audit.record({ actor: user.id, action, outcome: "denied", dealId: pending.dealId, reason: `Action already ${pending.status}.`, pendingActionId });
      return fail(`Action ${pendingActionId} is already ${pending.status}; nothing to do.`);
    }

    const currentDeal = this.crm.getDeal(pending.dealId);
    if (!currentDeal) {
      this.queue.resolve(pending.id, "rejected", user.id);
      this.audit.record({ actor: user.id, action, outcome: "rejected", dealId: pending.dealId, reason: `Deal '${pending.dealId}' no longer exists.`, pendingActionId });
      return fail(`Deal '${pending.dealId}' no longer exists; action rejected.`);
    }

    const conflicts = detectConflicts(pending.snapshot, currentDeal, pending.changes);
    if (conflicts.length > 0) {
      // Stale: the deal moved under the proposal. Reject rather than silently
      // overwrite, and hand the approver a 3-way comparison to re-propose from.
      this.queue.resolve(pending.id, "rejected", user.id);
      const changedFields = conflicts.map((conflict) => conflict.field).join(", ");
      this.audit.record({
        actor: user.id,
        action,
        outcome: "rejected",
        dealId: pending.dealId,
        before: pending.snapshot,
        after: cloneDeal(currentDeal),
        changes: pending.changes,
        reason: `Stale: deal changed underneath on ${changedFields}.`,
        pendingActionId,
      });
      return fail(
        `Deal changed since this was proposed (conflict on: ${changedFields}). Rejected as stale — re-propose against the current deal.`,
        conflicts,
      );
    }

    const before = cloneDeal(currentDeal);
    const updated = this.crm.updateDeal(pending.dealId, pending.changes);
    this.queue.resolve(pending.id, "approved", user.id);
    this.audit.record({
      actor: user.id,
      action,
      outcome: "approved",
      dealId: pending.dealId,
      before,
      after: updated,
      changes: pending.changes,
      pendingActionId,
    });
    return ok(`Approved ${pendingActionId}. Deal ${pending.dealId} updated.`, updated);
  }

  rejectAction(actorId: string, pendingActionId: string, reason?: string): GatewayResult {
    const action = "reject_pending_action";
    const user = this.authorizeWriter(actorId, action, "approve");
    if (!user) return denied(actorId, "reject actions");

    const pending = this.queue.getById(pendingActionId);
    if (!pending) {
      this.audit.record({ actor: user.id, action, outcome: "denied", reason: `Unknown pending action '${pendingActionId}'.`, pendingActionId });
      return fail(`No pending action with id '${pendingActionId}'.`);
    }
    if (pending.status !== "pending") {
      this.audit.record({ actor: user.id, action, outcome: "denied", dealId: pending.dealId, reason: `Action already ${pending.status}.`, pendingActionId });
      return fail(`Action ${pendingActionId} is already ${pending.status}.`);
    }

    this.queue.resolve(pending.id, "rejected", user.id);
    this.audit.record({
      actor: user.id,
      action,
      outcome: "rejected",
      dealId: pending.dealId,
      changes: pending.changes,
      reason: reason ?? "Rejected by approver.",
      pendingActionId,
    });
    return ok(`Rejected ${pendingActionId}.`, pending);
  }

  // ── Internal auth helpers ─────────────────────────────────────────────────

  /** Resolve a user for a read. Returns null only if the id is unknown. */
  private requireReader(actorId: string): User | null {
    const user = this.crm.getUser(actorId);
    if (!user) return null;
    return authorize(user, "read").allowed ? user : null;
  }

  /**
   * Resolve a user and check a write/approval capability. Any failure — unknown
   * user or missing capability — is recorded as a "denied" audit entry before
   * returning null, so every blocked write attempt (including Victor's) is trailed.
   */
  private authorizeWriter(
    actorId: string,
    action: string,
    capability: Capability,
    dealId?: string,
  ): User | null {
    const user = this.crm.getUser(actorId);
    if (!user) {
      this.audit.record({ actor: actorId, action, outcome: "denied", dealId, reason: `Unknown user '${actorId}'.` });
      return null;
    }

    const decision = authorize(user, capability);
    if (!decision.allowed) {
      this.audit.record({ actor: user.id, action, outcome: "denied", dealId, reason: decision.reason });
      return null;
    }

    return user;
  }
}

// ── Small pure helpers, kept out of the class for readability ───────────────

/** A true immutable snapshot of a deal. Deal is flat, so a shallow copy suffices. */
function cloneDeal(deal: Deal): Deal {
  return { ...deal };
}

/**
 * A field conflicts when the proposal wants to change it AND the live value has
 * already moved away from the snapshot the proposer saw. Fields the proposal does
 * not touch are ignored — an unrelated edit elsewhere on the deal is not a conflict.
 */
function detectConflicts(snapshot: Deal, current: Deal, changes: DealChange): FieldConflict[] {
  const proposedFields = Object.keys(changes) as (keyof DealChange)[];
  const conflicts: FieldConflict[] = [];

  for (const field of proposedFields) {
    if (snapshot[field] !== current[field]) {
      conflicts.push({
        field,
        base: snapshot[field],
        current: current[field],
        proposed: changes[field],
      });
    }
  }

  return conflicts;
}

// Result constructors — keep every return statement short and self-explanatory.
function ok(message: string, data?: unknown): GatewayResult {
  return { ok: true, message, data };
}

function fail(message: string, data?: unknown): GatewayResult {
  return { ok: false, message, data };
}

function denied(actorId: string, verb: string): GatewayResult {
  return { ok: false, message: `Permission denied: '${actorId}' may not ${verb}.` };
}

function unauthenticated(actorId: string): GatewayResult {
  return { ok: false, message: `Unknown user '${actorId}'.` };
}
