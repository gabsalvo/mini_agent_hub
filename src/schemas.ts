/**
 * Hub-level validation schemas.
 *
 * These run at the tool boundary, BEFORE anything reaches the approval queue, so a
 * malformed payload from the LLM — an invented field, a wrong type, or an empty
 * change — is rejected up front rather than polluting the queue or the audit log.
 */
import { z } from "zod";

/** The deal stages the CRM understands. Single source of truth for validation. */
export const DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;

/**
 * A proposed change to a deal. `.strict()` rejects fields the CRM does not have
 * (e.g. an LLM inventing "priority"); the refinement rejects an empty change.
 */
export const DealChangeSchema = z
  .object({
    stage: z.enum(DEAL_STAGES).optional(),
    value: z.number().nonnegative().optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .refine((change) => Object.keys(change).length > 0, {
    message: "A deal update must change at least one of: stage, value, notes.",
  });
