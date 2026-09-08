/** The three sample notes, registered sources and test cases used by the repo's demo. */

import { type Expectations, type Scenario } from "./executor";

export const REFUND_NOTE = `# Refund handling for online orders

## Before you start
- Confirm the order is within the 30-day return window (see doc:policy/refunds-v4).
- Confirm the payment was captured, not just authorised, in Stripe.

## Tools
- Stripe
- Zendesk
- OrderDB

## Steps
1. Look up the order in OrderDB by order number and verify the customer email matches the ticket.
2. Check the return reason against the accepted reasons list in doc:policy/refunds-v4.
   If reason is fraud, escalate to the risk team and stop.
3. Confirm the item was received back in the warehouse, expected: warehouse scan present in OrderDB.
4. Issue the refund in Stripe for the captured amount.
5. Reply to the customer in Zendesk with the refund confirmation number, so that the ticket can be closed. See ticket FIN-2210 for the reply template.

## Never
- Never refund to a different card than the one charged.
- Do not issue store credit instead of a refund unless the customer asks for it in writing.

## Done when
- Refund appears as succeeded in Stripe and the Zendesk ticket is solved.
`;

export const ONBOARDING_NOTE = `# New engineer onboarding checklist

## Prerequisites
- HR has marked the hire as started in Workday.
- Manager has filled the access request form at https://intranet.example.com/forms/access-request.

## Systems to use
- Okta
- GitHub
- Slack
- Jira

## Checklist
1. Create the Okta account using the corporate email from Workday.
2. Add the account to the engineering group in Okta so that GitHub and Jira SSO work.
3. Invite the GitHub user to the organisation with the team listed in the access request form.
   - If the role is contractor, invite as an outside collaborator on the named repositories only.
4. Add the person to the #eng-announcements and team channels in Slack.
5. Create the onboarding epic in Jira from template ONB-100 and assign it to the new hire.
6. Send the welcome message in Slack with the links from doc:onboarding/week-one.

## Rules
- If the start date is more than 7 days away, stop and schedule the checklist for the start date.

## Do not
- Never grant admin roles during onboarding.
- Do not share credentials over Slack.

## Done when
- The new hire can open GitHub, Jira and Slack through Okta.
`;

export const INCIDENT_NOTE = `# Incident triage for production alerts

## Preconditions
- The alert came from the production PagerDuty service, see https://status.example.com/runbooks/triage.
- You are the on-call engineer listed in PagerDuty.

## Tools
- PagerDuty
- Grafana
- Slack
- Jira

## Procedure
1. Acknowledge the alert in PagerDuty within 5 minutes.
2. Open the service dashboard in Grafana and check error rate and latency for the last 30 minutes.
3. If error rate exceeds 5 percent, declare a SEV1 in Slack and page the service owner.
4. If error rate is under 5 percent, post a status update in the #incidents Slack channel.
5. Create the incident ticket in Jira from template INC-77 with the alert link and the dashboard screenshot.
6. Mitigate using the runbook in doc:runbooks/service-triage, expected: error rate back under 1 percent.
7. Resolve the PagerDuty alert and link the Jira ticket in the resolution note.

## Never
- Never restart the database cluster without the service owner on the call.
- Do not close the alert before the Jira ticket exists.

## Done when
- The alert is resolved in PagerDuty and the Jira ticket links the timeline.
`;

export type NoteKey = "refund" | "onboarding" | "incident";

export interface SampleNote {
  key: NoteKey;
  file: string;
  title: string;
  short: string;
  body: string;
  required_approvals: number;
}

export const SAMPLE_NOTES: SampleNote[] = [
  {
    key: "refund",
    file: "refund_handling_sop.md",
    title: "Refund handling for online orders",
    short: "Refund SOP",
    body: REFUND_NOTE,
    required_approvals: 2,
  },
  {
    key: "onboarding",
    file: "onboarding_checklist.md",
    title: "New engineer onboarding checklist",
    short: "Onboarding checklist",
    body: ONBOARDING_NOTE,
    required_approvals: 1,
  },
  {
    key: "incident",
    file: "incident_triage_note.md",
    title: "Incident triage for production alerts",
    short: "Incident triage",
    body: INCIDENT_NOTE,
    required_approvals: 1,
  },
];

export interface SampleSource {
  kind: "doc" | "ticket" | "url";
  ref: string;
  title: string;
  content: string;
}

export const SAMPLE_SOURCES: SampleSource[] = [
  {
    kind: "doc",
    ref: "policy/refunds-v4",
    title: "Refund policy v4",
    content:
      "Refunds are accepted within 30 days. Refunds above 500 require manager approval before the refund is issued.",
  },
  {
    kind: "ticket",
    ref: "FIN-2210",
    title: "Refund reply template",
    content: "Template: Your refund of {amount} has been issued, confirmation {id}.",
  },
  {
    kind: "doc",
    ref: "onboarding/week-one",
    title: "Week one links",
    content: "Handbook, engineering wiki, on-call primer, expense policy.",
  },
  {
    kind: "ticket",
    ref: "ONB-100",
    title: "Onboarding epic template",
    content: "Epic template with 12 standard onboarding tasks.",
  },
  {
    kind: "url",
    ref: "https://intranet.example.com/forms/access-request",
    title: "Access request form",
    content: "Form fields: name, team, role, repositories.",
  },
  {
    kind: "url",
    ref: "https://status.example.com/runbooks/triage",
    title: "Triage runbook",
    content: "Ack within 5 minutes, check dashboards, declare severity.",
  },
  {
    kind: "doc",
    ref: "runbooks/service-triage",
    title: "Service triage runbook",
    content: "Scale out, roll back last deploy, fail over read replicas.",
  },
  {
    kind: "ticket",
    ref: "INC-77",
    title: "Incident ticket template",
    content: "Fields: alert link, dashboard screenshot, timeline.",
  },
];

export interface SampleTestCase {
  name: string;
  scenario: Scenario;
  expectations: Expectations;
}

export const SAMPLE_TEST_CASES: Record<NoteKey, SampleTestCase[]> = {
  refund: [
    {
      name: "fraud escalates to the risk team",
      scenario: { facts: { reason: "fraud", amount: 90 } },
      expectations: { required_actions: ["risk team"], forbidden_actions: ["Issue the refund"], must_halt: true },
    },
    {
      name: "standard refund completes",
      scenario: { facts: { reason: "damaged", amount: 40 } },
      expectations: { expected_tools: ["OrderDB", "Stripe", "Zendesk"], must_complete: true },
    },
    {
      name: "high value refund needs manager approval",
      scenario: { facts: { reason: "damaged", amount: 800 } },
      expectations: { required_actions: ["manager"], forbidden_actions: ["Issue the refund"], must_halt: true },
    },
  ],
  onboarding: [
    {
      name: "contractor gets outside collaborator invite",
      scenario: { facts: { role: "contractor", start_date: 1 } },
      expectations: { required_actions: ["outside collaborator"], must_complete: true },
    },
    {
      name: "far start date halts the checklist",
      scenario: { facts: { role: "engineer", start_date: 10 } },
      expectations: { must_halt: true, forbidden_actions: ["Create the Okta account"] },
    },
    {
      name: "never grants admin",
      scenario: { facts: { role: "engineer", start_date: 1 } },
      expectations: { forbidden_actions: ["admin"], expected_tools: ["Okta", "GitHub", "Slack", "Jira"] },
    },
  ],
  incident: [
    {
      name: "high error rate declares a SEV1",
      scenario: { facts: { error_rate: 7 } },
      expectations: { required_actions: ["SEV1"], expected_tools: ["PagerDuty", "Grafana", "Jira"], must_complete: true },
    },
    {
      name: "low error rate posts a status update",
      scenario: { facts: { error_rate: 2 } },
      expectations: { required_actions: ["status update"], forbidden_actions: ["SEV1"] },
    },
  ],
};

export interface Principal {
  name: string;
  role: "expert" | "reviewer" | "admin";
}

export const PEOPLE: Record<string, Principal> = {
  dana: { name: "dana", role: "expert" },
  ravi: { name: "ravi", role: "reviewer" },
  mei: { name: "mei", role: "reviewer" },
  ops: { name: "ops", role: "admin" },
};
