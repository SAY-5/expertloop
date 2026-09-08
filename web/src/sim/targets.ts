/**
 * Delivery targets (port of expertloop/targets/ plus the fakes the demo delivers to).
 *
 * The webhook target signs canonical JSON with HMAC-SHA256 over "<timestamp>.<body>" and the
 * fake receiver verifies the signature before issuing a receipt. The Jira target posts a comment
 * with the agent prompt and attaches the document as JSON. Both fakes run in memory and keep
 * everything they received so the summary can be computed from real records.
 */

import { canonicalCompact } from "./diff";
import { hmacSha256, sha256 } from "./sha256";
import { type InstructionDocument } from "./compile";

export const SIGNATURE_HEADER = "X-ExpertLoop-Signature";
export const TIMESTAMP_HEADER = "X-ExpertLoop-Timestamp";

export interface DeliveryPayload {
  event: string;
  action: "publish" | "rollback";
  instruction_set_id: number;
  name: string;
  version: number;
  document: InstructionDocument;
  [extra: string]: unknown;
}

export interface DeliveryReceipt {
  target: string;
  status: "delivered" | "failed";
  receipt: Record<string, unknown>;
}

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

export interface Target {
  readonly name: string;
  deliver(payload: DeliveryPayload, clock: () => number): DeliveryReceipt;
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return "sha256=" + hmacSha256(secret, `${timestamp}.${body}`);
}

export function verifySignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  return signPayload(secret, timestamp, body) === signature;
}

export interface WebhookRecord {
  receipt_id: string;
  timestamp: string;
  signature: string;
  verified: boolean;
  body_sha256: string;
  event: string;
  version: number;
  instruction_set_id: number;
  bytes: number;
}

/** Fake business-system receiver: verifies the signature and stores what it received. */
export class FakeWebhookReceiver {
  readonly received: WebhookRecord[] = [];
  private counter = 0;
  constructor(private readonly secret: string) {}

  accept(body: string, headers: Record<string, string>): { status: number; json: Record<string, unknown> } {
    const timestamp = headers[TIMESTAMP_HEADER] ?? "";
    const signature = headers[SIGNATURE_HEADER] ?? "";
    const verified = verifySignature(this.secret, timestamp, body, signature);
    if (!verified) return { status: 401, json: { error: "bad signature" } };
    const payload = JSON.parse(body) as DeliveryPayload;
    this.counter += 1;
    const record: WebhookRecord = {
      receipt_id: `whr-${this.counter}`,
      timestamp,
      signature,
      verified,
      body_sha256: sha256(body),
      event: payload.event,
      version: payload.version,
      instruction_set_id: payload.instruction_set_id,
      bytes: body.length,
    };
    this.received.push(record);
    return { status: 200, json: { receipt_id: record.receipt_id, verified: true, body_sha256: record.body_sha256 } };
  }
}

export class WebhookTarget implements Target {
  readonly name = "webhook";
  constructor(
    readonly url: string,
    private readonly secret: string,
    private readonly receiver: FakeWebhookReceiver,
  ) {}

  deliver(payload: DeliveryPayload, clock: () => number): DeliveryReceipt {
    const body = canonicalCompact(payload);
    const timestamp = String(clock());
    const headers = {
      "Content-Type": "application/json",
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signPayload(this.secret, timestamp, body),
    };
    const response = this.receiver.accept(body, headers);
    if (response.status >= 300) {
      throw new DeliveryError(`webhook rejected delivery: ${response.status} ${JSON.stringify(response.json)}`);
    }
    return { target: this.name, status: "delivered", receipt: { ...response.json, timestamp, signature: headers[SIGNATURE_HEADER] } };
  }
}

export interface JiraComment {
  id: string;
  issue: string;
  body: string;
}

export interface JiraAttachment {
  id: string;
  issue: string;
  filename: string;
  size: number;
}

/** Fake Jira: mimics the comment and attachment endpoints and keeps what it received. */
export class FakeJira {
  readonly comments: JiraComment[] = [];
  readonly attachments: JiraAttachment[] = [];
  private nextId = 10001;

  addComment(issue: string, body: string): JiraComment {
    const comment = { id: String(this.nextId++), issue, body };
    this.comments.push(comment);
    return comment;
  }

  addAttachment(issue: string, filename: string, content: string): JiraAttachment {
    const attachment = { id: String(this.nextId++), issue, filename, size: content.length };
    this.attachments.push(attachment);
    return attachment;
  }
}

export class JiraTarget implements Target {
  readonly name = "jira";
  constructor(
    readonly baseUrl: string,
    readonly issueKey: string,
    private readonly jira: FakeJira,
  ) {}

  deliver(payload: DeliveryPayload): DeliveryReceipt {
    const document = payload.document;
    const commentBody =
      `ExpertLoop ${payload.action}: ${document.title} ` +
      `(instruction set ${payload.instruction_set_id} v${payload.version})\n\n${document.agent_prompt}`;
    const comment = this.jira.addComment(this.issueKey, commentBody);
    const filename = `instruction-set-${payload.instruction_set_id}-v${payload.version}.json`;
    const attachment = this.jira.addAttachment(this.issueKey, filename, JSON.stringify(document, null, 2));
    return {
      target: this.name,
      status: "delivered",
      receipt: {
        issue: this.issueKey,
        comment: { id: comment.id },
        attachment: { id: attachment.id, filename, size: attachment.size },
      },
    };
  }
}
