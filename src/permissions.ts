/**
 * Server-side permission model.
 *
 * Permissions are decided here and nowhere else, so a tool author cannot forget a
 * check. Two independent dimensions keep the rules honest:
 *   - the ROLE ("sales" | "viewer") decides what a user may read and write, and
 *   - the APPROVER flag decides who may approve, regardless of role.
 * Keeping them separate means "a salesperson who isn't an approver" and "a user
 * with no rights at all" both fall out of the model without special-casing.
 */
import type { User } from "./crm.js";
import type { Capability } from "./types.js";

/** Capabilities granted purely by role. Approval is handled separately (see below). */
const CAPABILITIES_BY_ROLE: Record<User["role"], readonly Capability[]> = {
  sales: ["read", "write_low_risk", "write_high_risk"],
  viewer: ["read"],
};

export interface AuthorizationResult {
  allowed: boolean;
  /** Human-readable reason for a denial, recorded verbatim in the audit trail. */
  reason?: string;
}

/**
 * Does this user hold the required capability?
 *
 * "approve" is gated by the approver flag, not by any role, so an approver is
 * chosen deliberately rather than implied by being in sales.
 */
export function authorize(user: User, required: Capability): AuthorizationResult {
  if (required === "approve") {
    if (user.approver) {
      return { allowed: true };
    }
    return { allowed: false, reason: `User '${user.id}' is not an approver.` };
  }

  const grantedCapabilities = CAPABILITIES_BY_ROLE[user.role] ?? [];
  if (grantedCapabilities.includes(required)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Role '${user.role}' does not have capability '${required}'.`,
  };
}
