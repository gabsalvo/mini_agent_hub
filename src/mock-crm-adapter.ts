/**
 * Adapts the provided mock CRM (src/crm.ts) to the Hub's CrmPort.
 *
 * This is the ONLY module in the Hub that knows the concrete mock CRM exists. A
 * second backend would live in its own adapter (e.g. hubspot-crm-adapter.ts) next
 * to this one, and nothing else in the codebase would need to change.
 */
import * as crm from "./crm.js";
import type { CrmPort } from "./crm-port.js";
import type { User, Contact, Deal, Activity } from "./crm.js";
import type { DealChange } from "./types.js";

export class MockCrmAdapter implements CrmPort {
  getUser(id: string): User | undefined {
    return crm.getUser(id);
  }

  searchContacts(query: string): Contact[] {
    return crm.searchContacts(query);
  }

  getContact(id: string): Contact | undefined {
    return crm.getContact(id);
  }

  getDeal(id: string): Deal | undefined {
    return crm.getDeal(id);
  }

  listDeals(): Deal[] {
    return crm.listDeals();
  }

  updateDeal(id: string, changes: DealChange): Deal | undefined {
    return crm.updateDeal(id, changes);
  }

  logActivity(dealId: string, userId: string, note: string): Activity {
    return crm.logActivity(dealId, userId, note);
  }

  listActivities(dealId: string): Activity[] {
    return crm.listActivities(dealId);
  }
}
