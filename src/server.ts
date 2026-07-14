/**
 * Mini Agent Hub — MCP server.
 *
 * This file is deliberately thin: it composes the Hub's dependencies and registers
 * one MCP tool per operation. Each tool declares its arguments (Zod), calls the
 * Gateway, and serializes the result. All governance — permissions, the approval
 * queue, the audit trail — lives behind the Gateway, never here.
 *
 * Every tool takes a `user` argument identifying who the AI is acting for; this
 * stands in for real authentication.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MockCrmAdapter } from "./mock-crm-adapter.js";
import { ApprovalQueue } from "./approval-queue.js";
import { AuditLog } from "./audit-log.js";
import { Gateway } from "./gateway.js";
import { DEAL_STAGES } from "./schemas.js";
import type { GatewayResult } from "./types.js";

// ── Compose the Hub once (all in-memory for the challenge) ──────────────────

const crm = new MockCrmAdapter();
const approvalQueue = new ApprovalQueue();
const auditLog = new AuditLog();
const gateway = new Gateway(crm, approvalQueue, auditLog);

const server = new McpServer({ name: "mini-agent-hub", version: "1.0.0" });

// ── Reusable argument schemas ───────────────────────────────────────────────
// Declared once and shared, so each tool registration below stays a few clean lines.

// `.trim()` normalizes input at the boundary, so a stray space (e.g. "d1 ") still resolves —
// the ids reach the gateway already clean.
const userArg = z.string().trim().describe("ID of the user the AI is acting for (e.g. 'sara' or 'victor').");
const dealIdArg = z.string().trim().describe("Deal id, e.g. 'd1'.");
const actionIdArg = z.string().trim().describe("Pending action id, e.g. 'pa_1'.");
const queryArg = z.string().trim().describe("Search text, matched against contact name and company.");
const noteArg = z.string().trim().min(1).describe("The activity note to record.");
const reasonArg = z.string().trim().optional().describe("Optional reason, recorded in the audit log.");
const auditFilterArg = z.string().trim().optional().describe("Optional deal id to filter the audit trail.");
// The friendly way to update a deal: set stage / value / notes as individual fields.
const stageArg = z
  .enum(DEAL_STAGES)
  .optional()
  .describe("New stage: lead | qualified | proposal | negotiation | won | lost.");
const valueArg = z.number().nonnegative().optional().describe("New deal value (a number ≥ 0).");
const dealNotesArg = z.string().trim().optional().describe("New notes text for the deal.");

// Advanced alternative: a raw object. Loose on purpose — the authoritative, *audited* validation
// lives in the gateway (Gateway.proposeDealUpdate), so a malformed object (e.g. an invented
// field) leaves an audit trail instead of being silently rejected at the transport layer.
const changesArg = z
  .record(z.unknown())
  .optional()
  .describe(
    "Advanced: a raw changes object, as an alternative to the stage/value/notes fields. Unknown keys are rejected and the attempt is audited.",
  );

/** Serialize a GatewayResult into the MCP tool response shape. */
function toToolResult(result: GatewayResult) {
  const text =
    result.data !== undefined
      ? `${result.message}\n\n${JSON.stringify(result.data, null, 2)}`
      : result.message;

  return { content: [{ type: "text" as const, text }], isError: !result.ok };
}

// ── Read tools — available to any authenticated user ────────────────────────

server.tool(
  "search_contacts",
  "Search CRM contacts by name or company.",
  { user: userArg, query: queryArg },
  async ({ user, query }) => toToolResult(gateway.searchContacts(user, query)),
);

server.tool(
  "list_deals",
  "List every deal in the CRM.",
  { user: userArg },
  async ({ user }) => toToolResult(gateway.listDeals(user)),
);

server.tool(
  "view_deal",
  "View a single deal by id.",
  { user: userArg, dealId: dealIdArg },
  async ({ user, dealId }) => toToolResult(gateway.viewDeal(user, dealId)),
);

server.tool(
  "list_deal_activities",
  "List the activity notes logged against a deal.",
  { user: userArg, dealId: dealIdArg },
  async ({ user, dealId }) => toToolResult(gateway.listDealActivities(user, dealId)),
);

// ── Write tools — sales only; gated and audited ─────────────────────────────

server.tool(
  "log_activity",
  "Log an activity note on a deal. Low-risk: executes immediately.",
  { user: userArg, dealId: dealIdArg, note: noteArg },
  async ({ user, dealId, note }) => toToolResult(gateway.logActivity(user, dealId, note)),
);

server.tool(
  "update_deal",
  "Propose a change to a deal. The friendly way: set stage, value and/or notes directly. (Advanced: pass a raw `changes` object instead.) Only the fields you include change; omitted fields are left as-is. High-risk: this does NOT apply immediately — it is queued for an approver to release or reject.",
  { user: userArg, dealId: dealIdArg, stage: stageArg, value: valueArg, notes: dealNotesArg, changes: changesArg },
  async ({ user, dealId, stage, value, notes, changes }) => {
    // Two ways to describe the change: individual fields (friendly) or a raw `changes` object
    // (advanced). Individual fields win if both name the same key. The gateway then validates
    // and audits the result, so the friendly path enjoys exactly the same guarantees.
    const merged: Record<string, unknown> = { ...(changes ?? {}) };
    if (stage !== undefined) merged.stage = stage;
    if (value !== undefined) merged.value = value;
    if (notes !== undefined) merged.notes = notes;
    return toToolResult(gateway.proposeDealUpdate(user, dealId, merged));
  },
);

// ── Approval + oversight tools ──────────────────────────────────────────────

server.tool(
  "view_pending_queue",
  "View the actions currently waiting for approval.",
  { user: userArg },
  async ({ user }) => toToolResult(gateway.viewPendingQueue(user)),
);

server.tool(
  "approve_pending_action",
  "Approve a queued action (approver only). Re-checks for stale data, then applies the change to the CRM.",
  { user: userArg, actionId: actionIdArg },
  async ({ user, actionId }) => toToolResult(gateway.approveAction(user, actionId)),
);

server.tool(
  "reject_pending_action",
  "Reject a queued action so it never applies (approver only).",
  { user: userArg, actionId: actionIdArg, reason: reasonArg },
  async ({ user, actionId, reason }) => toToolResult(gateway.rejectAction(user, actionId, reason)),
);

server.tool(
  "view_audit_log",
  "View the audit trail of every write, approval and denial (newest first).",
  { user: userArg, dealId: auditFilterArg },
  async ({ user, dealId }) => toToolResult(gateway.viewAuditLog(user, dealId)),
);

// ── Connect over stdio ──────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mini-agent-hub MCP server running on stdio");
