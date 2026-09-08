# Refund handling for online orders

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
