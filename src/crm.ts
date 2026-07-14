/**
 * Mock CRM — treat this as an external system you talk to over an API.
 * Use only the exported functions; don't reach into the raw data from your
 * server code. (In the real world this would be Pipedrive or HubSpot.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface User {
  id: string;
  name: string;
  role: "sales" | "viewer";
  approver: boolean;
}

export interface Contact {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
}

export type DealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

export interface Deal {
  id: string;
  contactId: string;
  title: string;
  stage: DealStage;
  value: number;
  notes: string;
}

export interface Activity {
  id: string;
  dealId: string;
  userId: string;
  note: string;
  timestamp: string;
}

const seedPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf-8"));

const users: User[] = seed.users;
const contacts: Contact[] = seed.contacts;
const deals: Deal[] = seed.deals;
const activities: Activity[] = seed.activities;
let activityCounter = activities.length;

export function getUser(id: string): User | undefined {
  return users.find((u) => u.id === id);
}

export function searchContacts(query: string): Contact[] {
  const q = query.toLowerCase();
  return contacts.filter(
    (c) => c.name.toLowerCase().includes(q) || c.company.toLowerCase().includes(q)
  );
}

export function getContact(id: string): Contact | undefined {
  return contacts.find((c) => c.id === id);
}

export function getDeal(id: string): Deal | undefined {
  return deals.find((d) => d.id === id);
}

export function listDeals(): Deal[] {
  return [...deals];
}

/** Update a deal. Returns the updated deal, or undefined if it doesn't exist. */
export function updateDeal(
  id: string,
  changes: Partial<Pick<Deal, "stage" | "value" | "notes">>
): Deal | undefined {
  const deal = deals.find((d) => d.id === id);
  if (!deal) return undefined;
  Object.assign(deal, changes);
  return { ...deal };
}

/** Attach an activity note to a deal. Throws if the deal doesn't exist. */
export function logActivity(dealId: string, userId: string, note: string): Activity {
  if (!getDeal(dealId)) throw new Error(`Deal not found: ${dealId}`);
  const activity: Activity = {
    id: `a${++activityCounter}`,
    dealId,
    userId,
    note,
    timestamp: new Date().toISOString(),
  };
  activities.push(activity);
  return activity;
}

export function listActivities(dealId: string): Activity[] {
  return activities.filter((a) => a.dealId === dealId);
}
