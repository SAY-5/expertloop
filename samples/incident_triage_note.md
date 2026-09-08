# Incident triage for production alerts

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
