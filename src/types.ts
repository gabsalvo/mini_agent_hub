/**
 * Shared domain types for the Mini Agent Hub.
 *
 * These are the data shapes the whole gateway agrees on. They are deliberately
 * small and explicit so a reviewer can see, at a glance, exactly what a queued
 * action and an audit record contain.
 */
import type { Deal, DealStage } from "./crm.js";

/** A single permissioned capability. Roles are granted sets of these (see permissions.ts). */
export type Capability =
  | "read" // view contacts, deals, activities, the pending queue and the audit log
  | "write_low_risk" // execute immediately, e.g. log an activity note
  | "write_high_risk" // propose a change that must be approved, e.g. update a deal
  | "approve"; // release or reject items in the approval queue

/** Lifecycle of a queued action. Only a "pending" item may transition (double-approval guard). */
export type PendingStatus = "pending" | "approved" | "rejected";

/** The high-risk action types the queue understands. A union so adding more stays type-safe. */
export type PendingActionType = "update_deal";

/** The fields an assistant may change on a deal — mirrors crm.updateDeal's contract exactly. */
export interface DealChange {
  stage?: DealStage;
  value?: number;
  notes?: string;
}

/**
 * An action parked in the approval queue.
 *
 * `snapshot` is a COPY of the deal taken at propose time (crm.getDeal returns a
 * live reference, so we clone it). It is the "base" of the 3-way comparison the
 * approver is shown if the deal drifts before approval.
 */
export interface PendingAction {
  id: string; // monotonic, e.g. "pa_1" — unique by construction, never reused
  type: PendingActionType;
  dealId: string;
  changes: DealChange; // what was proposed
  snapshot: Deal; // cloned deal state at propose time (stale-detection base)
  proposedBy: string; // user id
  status: PendingStatus;
  createdAt: string; // ISO 8601
  resolvedBy?: string; // approver id, once resolved
  resolvedAt?: string; // ISO 8601, once resolved
}

/** Every outcome the gateway can record. One shape for every path = a trustworthy trail. */
export type AuditOutcome =
  | "executed" // low-risk write applied immediately
  | "queued" // high-risk write parked for approval
  | "approved" // queued action released and applied to the CRM
  | "rejected" // queued action rejected (by an approver, or automatically because it went stale)
  | "denied"; // a write/approval attempt blocked by permissions

/**
 * One audit record. Written for every write, approval, and denial — never for a
 * plain read. `before`/`after` hold CLONED deal state so they can never be mutated
 * out from under the log. An auditor can reconstruct what the agent did from these.
 */
export interface AuditRecord {
  id: string; // monotonic, e.g. "au_1"
  timestamp: string; // ISO 8601
  actor: string; // user id the AI acted for
  action: string; // tool / operation name, e.g. "update_deal"
  outcome: AuditOutcome;
  dealId?: string; // present when the action targets a deal
  before?: unknown; // cloned deal state before the change, where relevant
  after?: unknown; // cloned deal state after it was APPLIED (executed / approved) — absent on "queued"
  changes?: DealChange; // the proposed diff, on proposal records (queued / approved / rejected)
  reason?: string; // why denied/rejected, e.g. "viewer cannot write" or "stale: stage"
  pendingActionId?: string; // ties an audit record back to its queue item
}

/**
 * A single conflicting field in a 3-way (base / current / proposed) comparison.
 * Returned to the approver when a proposal is stale; not stored anywhere.
 */
export interface FieldConflict {
  field: string;
  base: unknown; // value the proposer saw (snapshot)
  current: unknown; // value the deal has now
  proposed: unknown; // value the assistant wants to set
}

/** The uniform envelope every gateway operation returns; the server serializes it to MCP. */
export interface GatewayResult {
  ok: boolean;
  message: string;
  data?: unknown;
}
