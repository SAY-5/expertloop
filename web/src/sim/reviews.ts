/**
 * Review policies, deadlines and reviewer workload (port of expertloop/reviews.py).
 *
 * A policy lives on the instruction set: which reviewer roles must be among the approvers,
 * whether the author of the current version may approve it, and how many hours a review may
 * take before it is escalated. `required_approvals` stays a field of its own.
 */

import { type State } from "./state";

export const REVIEW_ROLES = ["reviewer", "admin"] as const;
export const HOUR_MS = 3_600_000;

export interface ReviewPolicy {
  required_roles: string[];
  allow_self_approval: boolean;
  review_deadline_hours: number | null;
}

export const DEFAULT_POLICY: ReviewPolicy = {
  required_roles: [],
  allow_self_approval: false,
  review_deadline_hours: null,
};

export function normalisePolicy(policy?: Partial<ReviewPolicy> | null): ReviewPolicy {
  const hours = policy?.review_deadline_hours;
  return {
    required_roles: [...(policy?.required_roles ?? [])],
    allow_self_approval: policy?.allow_self_approval ?? false,
    review_deadline_hours: hours === undefined || hours === null ? null : Math.max(0, hours),
  };
}

export function unknownRoles(policy: Partial<ReviewPolicy>): string[] {
  return (policy.required_roles ?? []).filter((role) => !(REVIEW_ROLES as readonly string[]).includes(role));
}

export interface ApprovalRow {
  reviewer: string;
  reviewer_role: string;
}

/** Roles the policy demands that no approver on this round holds yet. */
export function missingRoles(policy: ReviewPolicy, approvals: ApprovalRow[]): string[] {
  const present = new Set(approvals.map((a) => a.reviewer_role));
  return policy.required_roles.filter((role) => !present.has(role));
}

/** Distinct approvals on this round and the roles still missing. */
export function policySatisfied(policy: ReviewPolicy, approvals: ApprovalRow[]): [number, string[]] {
  return [new Set(approvals.map((a) => a.reviewer)).size, missingRoles(policy, approvals)];
}

/** A review clock started at `now`; null when the policy sets no deadline. */
export function deadlineFrom(policy: ReviewPolicy, now: number): number | null {
  return policy.review_deadline_hours === null ? null : now + policy.review_deadline_hours * HOUR_MS;
}

export function isOverdue(state: State, deadline: number | null, now: number): boolean {
  return state === "in_review" && deadline !== null && deadline <= now;
}

/** Whole hours (rounded down) a set is past its deadline; 0 when it is not. */
export function overdueHours(deadline: number | null, now: number): number {
  if (deadline === null || deadline > now) return 0;
  return Math.floor((now - deadline) / HOUR_MS);
}

export function formatInstant(at: number | null): string {
  return at === null ? "-" : new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

export interface QueueRow {
  instruction_set_id: number;
  name: string;
  version: number;
  review_round: number;
  submitted_at: number | null;
  review_deadline_at: number | null;
  overdue: boolean;
  escalated: boolean;
  approvals: number;
  required_approvals: number;
  missing_roles: string[];
  waiting_on: string[];
}

export interface ReviewerRow {
  name: string;
  role: string;
  pending: number[];
  overdue: number;
  decided: number;
}

export interface Workload {
  generated_at: number;
  queue: QueueRow[];
  reviewers: ReviewerRow[];
}
