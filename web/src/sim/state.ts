/**
 * Approval state machine for instruction sets (port of expertloop/workflow/state.py).
 *
 *   draft -> in_review -> changes_requested -> in_review -> approved -> published -> retired
 *
 * Editing is allowed in draft, changes_requested, approved and published. An edit to an
 * approved set moves it back to draft; an edit to a published set (revise) also moves the head
 * to draft while published_version keeps pointing at the live version. Publishing additionally
 * requires a green test run on the current version, enforced by the service layer.
 */

export type State = "draft" | "in_review" | "changes_requested" | "approved" | "published" | "retired";

export const STATES: State[] = ["draft", "in_review", "changes_requested", "approved", "published", "retired"];

export type Action =
  | "submit"
  | "resubmit"
  | "request_changes"
  | "approve"
  | "edit_after_approval"
  | "publish"
  | "revise"
  | "retire";

export const TRANSITIONS: Record<Action, [State, State]> = {
  submit: ["draft", "in_review"],
  resubmit: ["changes_requested", "in_review"],
  request_changes: ["in_review", "changes_requested"],
  approve: ["in_review", "approved"],
  edit_after_approval: ["approved", "draft"],
  publish: ["approved", "published"],
  revise: ["published", "draft"],
  retire: ["published", "retired"],
};

export const EDITABLE_STATES: ReadonlySet<State> = new Set<State>(["draft", "changes_requested", "approved", "published"]);

export class IllegalTransition extends Error {
  readonly action: string;
  readonly current: State;
  constructor(action: string, current: State) {
    super(`cannot ${action} an instruction set in state ${current}`);
    this.name = "IllegalTransition";
    this.action = action;
    this.current = current;
  }
}

/** Return the target state for `action` from `current` or throw IllegalTransition. */
export function assertTransition(action: string, current: State): State {
  const entry = (TRANSITIONS as Record<string, [State, State] | undefined>)[action];
  if (!entry) throw new IllegalTransition(action, current);
  const [source, target] = entry;
  if (current !== source) throw new IllegalTransition(action, current);
  return target;
}

/** Actions legal from a given state, for the diagram. */
export function legalActions(current: State): Action[] {
  return (Object.keys(TRANSITIONS) as Action[]).filter((action) => TRANSITIONS[action][0] === current);
}
