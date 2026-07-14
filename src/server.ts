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
import type { GatewayResult } from "./types.js";

// ── Compose the Hub once (all in-memory for the challenge) ──────────────────

const crm = new MockCrmAdapter();
const approvalQueue = new ApprovalQueue();
const auditLog = new AuditLog();
const gateway = new Gateway(crm, approvalQueue, auditLog);

const server = new McpServer({ name: "mini-agent-hub", version: "1.0.0" });

// ── Reusable argument schemas ───────────────────────────────────────────────
// Declared once and shared, so each tool registration below stays a few clean lines.

const userArg = z.string().describe("ID of the user the AI is acting for (e.g. 'sara' or 'victor').");
const dealIdArg = z.string().describe("Deal id, e.g. 'd1'.");
const actionIdArg = z.string().describe("Pending action id, e.g. 'pa_1'.");
const queryArg = z.string().describe("Search text, matched against contact name and company.");
const noteArg = z.string().min(1).describe("The activity note to record.");
const reasonArg = z.string().optional().describe("Optional reason, recorded in the audit log.");
const auditFilterArg = z.string().optional().describe("Optional deal id to filter the audit trail.");
// Loose on purpose: the authoritative, *audited* validation lives in the gateway
// (Gateway.proposeDealUpdate), so a malformed payload leaves an audit trail instead of being
// silently rejected here at the transport layer.
const changesArg = z
  .record(z.unknown())
  .describe(
    "Proposed changes as an object. Recognized fields: stage (lead|qualified|proposal|negotiation|won|lost), value (number ≥ 0), notes (string). At least one is required; unknown fields are rejected and the attempt is audited.",
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
  "Propose a change to a deal (stage, value and/or notes). Only the fields you include are changed; any field you omit is left as-is. High-risk: this does NOT apply immediately — it is queued for an approver to release or reject.",
  { user: userArg, dealId: dealIdArg, changes: changesArg },
  async ({ user, dealId, changes }) => toToolResult(gateway.proposeDealUpdate(user, dealId, changes)),
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
