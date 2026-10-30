# XP-PAYTECH-05: late-paid and conflicting payment reports

A payment can be closed here and still be paid at PayTech. This workflow keeps that report, tells an administrator, and gives them a way to settle it. It never completes the payment, grants access or moves money by itself.

**Status: built and tested locally. Not live.** Migration 064 has not been applied to any hosted database. The workflow has not been exercised with PayTech, and the refund policy is undecided. This remains a mandatory blocker before live payments.

## Why it is needed

Migration 063 makes `cancelled`, `failed` and `expired` final, and it allows `refunded` only from `completed`. Those rules stay. A report that cannot move the payment is recorded beside it, in `public.payment_exceptions`, one record per payment.

## When a record is made

| What happened | Recorded as | Payment received |
|---|---|---|
| An authentic paid notification on a closed payment | `paid_hint`, open | Reported, not proven |
| An authentic paid notification on a payment still in flight, not settled | `paid_hint`, watching | Reported, not proven |
| A notification with our credentials that fails the signature check, or a signed one with an unknown event | `unverified_report`, open if closed, watching if in flight | Not established |
| The provider confirms payment on a closed payment | `provider_paid`, open | Confirmed by the provider |
| The provider confirms payment and `complete_payment()` refuses it | `completion_refused`, open | Confirmed by the provider |
| The provider says a closed payment can still be paid | `provider_pending`, open | Not established |
| A cancellation on a completed payment | `cancel_hint`, open | Already confirmed |
| The provider says a completed payment was not paid | `provider_not_paid`, open | Already confirmed |
| A claimed amount or currency disagrees with the record | `amount_mismatch` or `currency_mismatch`, open | Reported, not proven |

A notification is not proof. Its signature covers the amount and the reference, never the outcome, so it can only make a payment "reported". While the settlement contract is unconfirmed, no status request is sent.

A **watching** record raises no alert at first, because the payment may still settle normally. If the payment completes, the record resolves itself. If it closes by any path, the record opens in the same transaction as the closure. If neither happens, the next sweep after a day opens it and alerts, so it cannot sit unseen.

## Four facts, kept apart

| Fact | Values | Who sets it |
|---|---|---|
| Payment received | Not established, reported, confirmed by an administrator, confirmed by the provider, not received | Reports raise it; an administrator can confirm or deny a report. Confirmed money cannot be denied |
| Access granted | No, or yes for this payment | An administrator, and only if live access already exists |
| Refund required | To decide, yes, no | An administrator, after receipt is confirmed |
| Refund confirmed | No, or yes with reference, amount and date | An administrator, after the refund happened outside this system |

The queue also shows whether the learner has live access from any source, and whether the learner has another completed payment for the same course, which suggests a double payment.

## What an administrator can do

Everything is in **Admin > Paiements > Anomalies**.

| Action | Needs | Effect |
|---|---|---|
| Check with PayTech again | Nothing | Sends nothing while the contract is unconfirmed. With a contract, it adds to the record of a closed or completed payment. On an in-flight payment, it may complete or close it, through the same rules as a notification |
| Confirm receipt | An attested dashboard check | Records that funds arrived. Grants nothing |
| Nothing to return | An attested check, and receipt not confirmed (a completed payment may always be cleared) | Resolves the record. New evidence reopens it |
| Refund required | Confirmed receipt | Records the obligation. Sends nothing |
| Record a full refund | Refund required, plus reference, amount, date and an attestation | Resolves the record |
| Record access | Confirmed receipt, plus live access granted separately in **Accès formations** | Resolves the record. Creates no access |
| Review a report after settlement | A paid notification after a recorded refund or access decision, and an attested check | Clears the warning. Changes no settled fact |
| Withdraw a refund decision | Refund required, and none recorded | Returns it to "to decide", so a mistake cannot block the learner for good |
| Withdraw an administrator's confirmation | No refund decision resting on it | Restores the evidence as it was. What PayTech confirmed cannot be withdrawn |

Every action needs a platform administrator and a written reason, and each is audited. Accepted decisions are audited in the same transaction as the change. The application can only read this table: every write goes through these functions, so no state can change without its checks and its audit row.

### How a refund is recorded

The record keeps the refund facts. The payment moves only where migration 063 already allows it:

| Payment is | After the refund is recorded |
|---|---|
| Closed | Unchanged |
| In flight | `failed` |
| Completed | `refunded`. Access stays until an administrator changes it, and the page says so |

Only a refund of the full amount can be recorded. A partial refund is refused until a policy exists, because recording one as settled could close a record while money is still owed. One external reference can settle only one record. Recording the same refund twice changes nothing.

Settled facts are final. A paid notification after a recorded refund or access decision could still be a second real payment, because nothing proves the checkout can no longer be paid. It alerts an administrator and blocks a new attempt until it is reviewed, without changing what was recorded. Only a notification does this: a status check alone does not, because the provider may keep answering "paid" after a refund. A second refund on the same payment has no structured record yet: it goes in the administrator's reason, in the audit log.

## What it will never do

* Complete a payment, or call `complete_payment()`.
* Create or change an entitlement or an enrollment.
* Issue a refund, or assume PayTech offers a way to request one.
* Weaken migration 063, which is unchanged.

## How it behaves around retries and failures

* **Repeated notifications** count on the one record. They write no new audit row and send no new alert. An alert still due is left for the sweep.
* **The exception is a record marked "nothing to return".** A paid notification after that reopens it, even if it repeats an earlier one, because a repeat cannot be told from a new payment. It fails towards a human, and it blocks that learner's checkout for that course again until it is cleared.
* **A report that cannot be recorded is not acknowledged.** The notification route answers 503, so PayTech can retry.
* **A failed alert stays due.** The sweep tries again, and the queue shows the record regardless. Delivery is at least once, so reports arriving together can send more than one.
* **Checkout refuses a new attempt** while an open record concerns that learner and course, because a second attempt could take the money twice. It checks again after the provider call, before any URL is handed out. If it cannot check, it opens nothing.

## Applying it

Migration `064_payment_exceptions.sql` requires migrations through 063, refuses to run otherwise, and tests itself in a transaction that it rolls back. The operator steps and rollback are at the foot of the file. The rollback refuses while any record is open, watching or flagged after settlement, because dropping the table would destroy the record of money that may be owed. Roll back 064 before 063, and export resolved records first.

Apply it before this code takes real payments. Without it, the code fails closed: checkout refuses and the notification route answers 503.

## What this evidence does not prove

* How PayTech behaves. The provider is simulated, and its retry policy and refund options are unconfirmed.
* That a refund happened. A recorded refund is an administrator's statement, and this system cannot verify it.
* Delivery of a real alert email. The sender is simulated in these tests.
* Lock contention between two database sessions. PGlite has one connection.

A payment made after closure with no notification cannot be detected until the settlement contract is confirmed.
