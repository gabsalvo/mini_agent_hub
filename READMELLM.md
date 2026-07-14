# READMELLM.md — machine-optimized spec

Dense, unambiguous reference for an LLM/agent reading or extending this repo. Human-facing
prose, setup, and rationale live in [`README.md`](./README.md). This file states facts, rules,
shapes, and invariants. Everything here reflects the current code.

## PURPOSE
MCP (Model Context Protocol) server in TypeScript. An "Agent Hub" that gates an AI assistant
acting on a mock CRM: low-risk writes execute immediately, high-risk writes queue for approval,
permissions are enforced server-side, and every write/approval/denial is audited.

## RUN
- Requires Node ≥ 18. `npm install` → `npm run build` (tsc → `dist/`) → server entry `dist/server.js`.
- Transport: stdio. Clients (MCP Inspector, Claude Code) spawn `node dist/server.js` themselves.
- `npm run demo` (Windows) / `npm run demo:unix` — free Inspector ports 6274/6277, build, launch Inspector.
- All state is in-memory; a restart resets seed data and the `pa_N`/`au_N` counters.

## USERS (seed, from `data/seed.json`; `user` arg = auth stand-in)
| id | role | approver | capabilities |
|---|---|---|---|
| `sara` | sales | true | read, write_low_risk, write_high_risk, approve |
| `victor` | viewer | false | read |

Deals: `d1` proposal/45000, `d2` qualified/18000, `d3` negotiation/27500, `d4` lead/60000.
Contacts `c1..c4`. One seed activity `a1` on `d1`. Queue + audit start empty.

## TOOLS (all take `user`; registered in `server.ts`, logic in `gateway.ts`)
| tool | extra args | needs | risk | effect | audited |
|---|---|---|---|---|---|
| `search_contacts` | `query` | read | — | contacts by name/company | no |
| `list_deals` | — | read | — | all deals | no |
| `view_deal` | `dealId` | read | — | one deal | no |
| `list_deal_activities` | `dealId` | read | — | activities for a deal | no |
| `log_activity` | `dealId`,`note` | write_low_risk | low | append activity NOW | yes: `executed` |
| `update_deal` | `dealId`,`changes` | write_high_risk | high | QUEUE a proposal (not applied) | yes: `queued` |
| `view_pending_queue` | — | read | — | pending actions | no |
| `approve_pending_action` | `actionId` | approve | — | apply a queued change | yes: `approved`/`rejected`/`denied` |
| `reject_pending_action` | `actionId`,`reason?` | approve | — | drop a queued change | yes: `rejected`/`denied` |
| `view_audit_log` | `dealId?` | read | — | audit trail, newest first | no |

`changes` = object with any of `stage` (enum), `value` (number ≥ 0), `notes` (string); ≥1 field;
unknown keys rejected. The transport schema is loose (`z.record`); the AUTHORITATIVE, audited
validation is `DealChangeSchema.safeParse` inside `Gateway.proposeDealUpdate`.

## PERMISSION RULES (`permissions.ts`, enforced server-side in the gateway)
- role→caps: `sales → {read, write_low_risk, write_high_risk}`, `viewer → {read}`.
- `approve` is granted by the `approver` flag, independent of role.
- Order in writes/approvals: resolve user → check capability. Unknown user OR missing capability
  ⇒ `audit{denied}` + return. For `update_deal`, permission is checked BEFORE payload validation.
- Reads: any known user passes; unknown user ⇒ error, NOT audited.

## GATEWAY DECISION LOGIC (pseudocode; `gateway.ts`)
```
READ(actor):                     # search/list/view/queue/audit
  u = getUser(actor); if !u: return error            # not audited
  return data                                         # not audited

logActivity(actor, dealId, note):
  u = authorizeWriter(actor, write_low_risk)          # fail ⇒ audit{denied}, return
  if !getDeal(dealId): audit{rejected: not found}; return
  a = crm.logActivity(...); audit{executed, after:a}; return a

proposeDealUpdate(actor, dealId, rawChanges):
  u = authorizeWriter(actor, write_high_risk)         # fail ⇒ audit{denied}, return
  v = DealChangeSchema.safeParse(rawChanges)
  if !v.ok: audit{rejected: "Invalid payload: ..."}; return   # never queued
  if !getDeal(dealId): audit{rejected: not found}; return
  snap = clone(deal)                                  # crm returns live ref → MUST clone
  pa = queue.enqueue(pending, changes=v.data, snapshot=snap)
  audit{queued, before:snap, changes}                 # NO `after` (nothing applied yet)
  return pa

approveAction(actor, id):
  u = authorizeWriter(actor, approve)                 # fail ⇒ audit{denied}, return
  pa = queue.get(id); if !pa: audit{denied: unknown}; return
  if pa.status != pending: audit{denied: already X}; return   # double-approval no-op
  cur = getDeal(pa.dealId); if !cur: resolve(rejected); audit{rejected: gone}; return
  conflicts = fieldsIn(pa.changes) where snapshot[f] != cur[f]     # 3-way drift
  if conflicts: resolve(rejected); audit{rejected: stale}; return conflicts  # {field,base,current,proposed}
  crm.updateDeal(...); resolve(approved); audit{approved, before:cur, after, changes}

rejectAction(actor, id, reason?):
  u = authorizeWriter(actor, approve)
  pa = queue.get(id); guard unknown/already-resolved ⇒ audit{denied}
  resolve(rejected); audit{rejected, reason}
```

## DATA SHAPES (`types.ts`)
```ts
Capability = "read" | "write_low_risk" | "write_high_risk" | "approve"
PendingStatus = "pending" | "approved" | "rejected"
AuditOutcome  = "executed" | "queued" | "approved" | "rejected" | "denied"
DealChange = { stage?: DealStage; value?: number; notes?: string }

PendingAction = { id, type:"update_deal", dealId, changes:DealChange,
                  snapshot:Deal /*clone*/, proposedBy, status:PendingStatus,
                  createdAt, resolvedBy?, resolvedAt? }

AuditRecord = { id, timestamp, actor, action, outcome:AuditOutcome, dealId?,
                before?, after?, changes?, reason?, pendingActionId? }
```
Rule: `queued` ⇒ has `before`+`changes`, NO `after`. `approved`/`executed` ⇒ has real `after`.
`before`/`after`/`snapshot` are always CLONES (`{...deal}`), never live refs.

## IDS (`sequence.ts`)
Monotonic per-kind counter: `pa_1, pa_2, …` (pending), `au_1, au_2, …` (audit). One allocator ⇒
unique by construction, never reused. Append-only stores never delete (status transitions only).
In-memory ⇒ resets to 1 on restart (documented trade-off; prod = DB sequence / ULID).

## EDGE-CASE RULES
- Double approval/reject: only `status==pending` transitions; else `audit{denied}` no-op.
- Stale: re-read deal at approval, compare changed fields vs `snapshot`; drift ⇒ reject + return
  `[{field,base,current,proposed}]` + `audit{rejected: stale}`. Never silent overwrite.
- Deal missing at approval: reject + audit. (mock CRM has no delete, so defensive.)
- Malformed `update_deal` payload: reject + `audit{rejected: "Invalid payload: ..."}` (in gateway).
- Unauthorized/unknown user on write/approve: `audit{denied}`. On read: plain error, not audited.

## INVARIANTS (guarantees to preserve)
1. Every write/approval/denial ⇒ exactly one audit record. Reads ⇒ zero.
2. A high-risk change hits the CRM ONLY via `approveAction` (never on propose).
3. Permission is checked server-side in the gateway; no tool can bypass it.
4. Audit log is append-only; records/`before`/`after` are immutable clones.
5. The governance layer never CALLS `crm.ts`; it goes through `CrmPort`. Only
   `mock-crm-adapter.ts` calls `crm.ts`. (Type-only `import type` of Deal/User is fine.)

## FILE MAP (`src/`)
| file | responsibility | internal deps |
|---|---|---|
| `server.ts` | MCP wiring + tool registration + composition root | gateway, mock-crm-adapter, approval-queue, audit-log, types |
| `gateway.ts` | governance core: auth → validate → risk → execute/queue → audit | crm-port, permissions, schemas, audit-log, approval-queue, types, crm(types) |
| `permissions.ts` | role→capability + approver gate → `authorize()` | types, crm(types) |
| `approval-queue.ts` | FIFO pending store + status-guarded `resolve()` | sequence, types, crm(types) |
| `audit-log.ts` | append-only `record()` / `list()` | sequence, types |
| `crm-port.ts` | `CrmPort` interface (the CRM contract) | crm(types), types |
| `mock-crm-adapter.ts` | `CrmPort` impl over `crm.ts` — ONLY caller of crm.ts | crm-port, crm, types |
| `schemas.ts` | `DealChangeSchema` (strict, non-empty), `DEAL_STAGES` | (zod only) |
| `sequence.ts` | monotonic id allocator | (none) |
| `types.ts` | shared shapes | crm(types) |
| `crm.ts` | GIVEN mock CRM; do not edit; public methods only | (fs) |
