/**
 * The port the Hub talks to instead of a concrete CRM.
 *
 * Everything above this line — the gateway, the tools, the audit trail — depends
 * only on this interface, never on src/crm.ts directly. Swapping in a second CRM
 * backend (HubSpot, Pipedrive, …) means writing one new adapter that implements
 * CrmPort; the governance layer does not change. This is the Adapter pattern that
 * keeps the Hub CRM-agnostic.
 */
import type { User, Contact, Deal, Activity } from "./crm.js";
import type { DealChange } from "./types.js";

export interface CrmPort {
  /** Look up the acting user. Stands in for real authentication in this challenge. */
  getUser(id: string): User | undefined;

  searchContacts(query: string): Contact[];
  getContact(id: string): Contact | undefined;

  getDeal(id: string): Deal | undefined;
  listDeals(): Deal[];
  /** Apply a change to a deal. Returns the updated deal, or undefined if it doesn't exist. */
  updateDeal(id: string, changes: DealChange): Deal | undefined;

  /** Attach an activity note to a deal. Throws if the deal doesn't exist. */
  logActivity(dealId: string, userId: string, note: string): Activity;
  listActivities(dealId: string): Activity[];
}
