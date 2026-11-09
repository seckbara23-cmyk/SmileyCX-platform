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
| A notification with our credentials that fails the signature check, or a signed one with an unknown event | `unverified_report`, open if closed, watching if in flight | Not established, or reported when a completion notice already holds a paid notification |
| On a completed payment, any claim in a notification beyond the one its completion covers: another paid notification, a cancellation the provider does not answer, an amount or currency that disagrees, an unknown event or a failed signature | Kept on a settled record, or on the open one if there is one, and counted. Reopens nothing and blocks nobody | Already confirmed |
| The provider confirms payment on a closed payment | `provider_paid`, open | Confirmed by the provider |
| The provider confirms payment and `complete_payment()` refuses it | `completion_refused`, open | Confirmed by the provider |
| The provider says paid at nothing, or gives no amount where the contract requires one, on a payment not completed | `amount_mismatch`, open | Reported, not proven |
| The provider answers with a status word the contract does not list | `amount_mismatch`, open. Beside a notification the record stays `paid_hint`, and the word is kept after it as the provider's last answer | Reported, not proven, or already confirmed on a completed payment |
| The provider says a closed payment can still be paid | `provider_pending`, open | Not established |
| The provider says a completed payment was not paid | `provider_not_paid`, open | Already confirmed |
| The provider says a completed payment was paid at another amount or currency | `amount_mismatch` or `currency_mismatch`, open | Already confirmed |
| A claimed amount or currency disagrees with the record of a payment not yet completed | `amount_mismatch` or `currency_mismatch`, open | Reported, not proven |

A notification is not proof. Its signature covers the amount and the reference, never the outcome, so it can only make a payment "reported". Only the provider's answer, whichever path asked for it, can put a completed payment in question, because a refund is offered on an open record. While the settlement contract is unconfirmed, no status request is sent.

A **watching** record raises no alert at first, because the payment may still settle normally. If the payment completes, the record resolves itself, and it is flagged for an administrator if it holds more than one different notification. If it closes by any path, the record opens in the same transaction as the closure. If neither happens, the next sweep after a day opens it and alerts, so it cannot sit unseen.

**A completed payment covers one notification.** It is remembered in `public.payment_completion_notices`, written before the completion when a notification drives it, so a payment completed by its one paid notification gets no exception record at all. A paid notification the provider has not yet confirmed is watched instead, so that payment does have a record, which settles if the payment completes. A payment completed any other way takes the first paid notification that arrives afterwards. Any other paid notification on that payment may be a second real payment, so it is recorded, whatever the payment's state.

A provider's answer that contradicts a payment not yet completed does not close it. An administrator who has checked the dashboard can close the attempt, and then settle the record. An attempt the provider calls "pending", naming no other amount or currency, can be closed that way only 7 days after it was created, because the old link may still be payable. Once closed that way, "pending" opens no record, and a later payment does: the sweep keeps asking about the newest 200 attempts a person closed, whatever their age, and a notification that fails a check does not rewrite that close.

## Four facts, kept apart

| Fact | Values | Who sets it |
|---|---|---|
| Payment received | Not established, reported, confirmed by an administrator, confirmed by the provider, not received | Reports raise it; an administrator can confirm or deny a report. Confirmed money cannot be denied, unless the provider confirmed it and its last word is that it was not paid or can still be paid, or proves nothing while no amount it named stands. What it confirmed then stays on the record |
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
| Nothing to return | An attested check, and receipt not confirmed (a completed payment may always be cleared, and so may money the provider confirmed if its last word is that it was not paid or can still be paid, or proves nothing while no amount it named stands). If the record holds more than one different report, a further attestation | Resolves the record. New evidence is judged as described below |
| Refund required | Confirmed receipt. The same further attestation applies | Records the obligation. Sends nothing |
| Record a full refund | Refund required, plus reference, amount, date and an attestation. If the record holds more than one different notification, a further attestation that they were checked | Resolves the record |
| Record access | Confirmed receipt, plus live access granted separately in **Accès formations**. The same further attestation applies | Resolves the record. Creates no access |
| Review a report on a settled record | A flag, or a counted notification, and an attested check | Clears the warning. Changes no settled fact |
| Report money this record does not cover | A resolved record, and an attested dashboard check | Reopens the record, or flags it if a refund or access decision is settled or the payment completed. Changes no settled fact. On a completed payment, the money found is a different payment, so this cannot lead to refunding the completed one, unless the provider's last word still questions that payment, when it reopens |
| Withdraw a refund decision | Refund required, and none recorded | Returns it to "to decide", so a mistake cannot block the learner for good |
| Withdraw an administrator's confirmation | No refund decision resting on it | Restores the evidence as it was. What PayTech confirmed cannot be withdrawn |

Every decision needs a platform administrator and a written reason, and each is audited. The last reason is also shown on the record. A re-check needs only the administrator, and is audited too. Accepted decisions are audited in the same transaction as the change. The application can only read this table: every write goes through these functions, so no state can change without its checks. A counted report writes a row only for a new digest, the first repeat in an alert period or a change in what the provider says that questions the record, and an alert stamp writes none, so that repeats cannot flood the log.

### How a refund is recorded

The record keeps the refund facts. The payment moves only where migration 063 already allows it:

| Payment is | After the refund is recorded |
|---|---|
| Closed | Unchanged |
| In flight | `failed` |
| Completed | `refunded`. Access stays until an administrator changes it, and the page says so |

Only a refund of the full amount can be recorded. A partial refund is refused until a policy exists, because recording one as settled could close a record while money is still owed. If the provider's last word names another amount, the whole of any amount it has named on this record can be recorded instead, under a further attestation if it has named more than one. The amount charged can be recorded too. Anything below that last amount, whether the amount charged or an amount it named earlier, needs a further attestation that it is all that was received, because the figure may include what never reached us. Once it says paid at our amount, only the amount charged can. On a completed payment, nothing below the amount charged can be recorded, and nothing between it and the last amount. The queue shows every amount named, and only the dashboard says which was received. One external reference can settle only one record. Recording the same refund twice changes nothing, and is audited.

Settled facts are final. A different paid notification after a recorded refund or access decision could still be a second real payment, because nothing proves the checkout can no longer be paid. It alerts an administrator and blocks a new attempt until it is reviewed, without changing what was recorded. A status check does this only by giving an answer it has not given on this record, or naming an amount it has not named there. An amount it has named before does not flag again, and reaches a person at most weekly, with the one exception below. The provider may well keep answering "paid" with the right amount after a refund, and that alone is not new unless it named another amount first. "Not paid" flags an access decision or a completed payment, and is what a refunded payment should hear.

## What it will never do

* Complete a payment, or call `complete_payment()`.
* Create or change an entitlement or an enrollment.
* Issue a refund, or assume PayTech offers a way to request one.
* Weaken migration 063, which is unchanged.

## How it behaves around retries and failures

* **Repeated notifications** count on the one record. They send nothing on arrival. An alert still due is left for the sweep.
* **A notification an administrator has already reviewed** only counts if it comes again. It reopens nothing, flags nothing and does not block the learner. It stays visible in the queue, and the sweep sends at most one alert per record per week about it, beside the reminder of a record still waiting for a person. A notification that repeats the one a completed payment covers is treated the same way, so a second delivery of one can raise an alert.
* **A notification with different content** reopens or flags the record, a limited number of times per record. On a closed attempt that alerts and blocks a new attempt, and on one in flight the record is watched. After that it is counted and alerted on without blocking anyone: the first since a review at the next sweep, later ones at most weekly. So is one that arrives while the record is already flagged, and one on a completed payment.
* **A report that failed its check** alerts an administrator, and on its own blocks nobody. If the payment then completes, the record is flagged.
* **A status check's answer that questions a record is news the first time it is given there.** So is an amount other than ours that it says was paid and has not named there. Those amounts are kept on the record, up to a limit. "Pending" on an attempt in flight counts only where the provider has already said more on the record, which it then replaces as its last word. Any other change in what it says, an amount named before or an answer it has given before, only updates the record and alerts at most weekly, so going back and forth cannot keep blocking. The one exception is "paid" after its last word on a record was "not paid", "pending", a status word the contract does not list or a paid answer with no readable amount, which is news once. "Not paid" on a refunded attempt is kept once and flags nothing, so that "paid" after it is seen. An unpaid answer saying 0 claims no amount. "Paid" at nothing, or with no amount the contract requires, proves no money: on a payment not completed it is kept for a person, and can be dismissed. Money the provider confirmed can be dismissed once its last word is that it was not paid or can still be paid, or proves nothing while no amount it named stands, and what it confirmed stays on the record. A status word the contract does not list is logged and opens or flags the record for a person, once, because it may mean money moved, and on a payment not completed it blocks a new attempt until they have read it. Beside a notification it becomes the provider's last word on that record, and the notification's claim stands. When the provider takes back what it questioned on a completed payment, the queue says so. Where it questions what the record holds it opens or flags the record, or alerts again if the record is already open, and otherwise it is at most kept for the administrator. "Still payable" on a dismissed attempt is marked and alerted on, and blocks nobody. A status check saying it again reopens nothing that has been resolved, so a provider repeating itself cannot keep blocking a learner. A notification with different content that prompts the same answer can reopen a dismissed record within the limit above, and on a completed payment it is counted and marked instead. The queue shows any disagreement apart from what a notification wrote.
* **A completion does not settle what it does not cover.** A record the provider has questioned, or on which an administrator confirmed money, stays open or opens, and that money then reads as confirmed by the provider. A refusal the platform itself raised and later honours is settled by that completion, when the record holds no settlement detail, provider answer or amount, digest, repeat, administrator mark or pending refund decision. A form from before the completion is out of date, and the alert goes out again. Anything else beyond the one paid notification is flagged, and that record offers no refund. So is money an administrator attested to before the payment completed, and a dismissal the completion now contradicts. An access decision already recorded stays as it is. Several reports held when it was made needed the further attestation, and later ones were flagged or counted as they arrived.
* **Evidence stays through a change of state.** A flag an administrator raised stays through a reopening, and remains after a dismissal until it is reviewed.
* **Several different reports may mean several payments.** The queue shows how many a record holds, and a dismissal, a refund decision, a recorded refund or an access decision on more than one needs its own attestation.
* **A decision covers the evidence it showed.** Each form states the version of the record it showed. The version moves when that evidence changes: a new report, an answer or an amount from the provider, a flag, the record's state, its money, or the payment completing under a record still open. A decision from before that, or one that does not say, is refused, so the page must be read again. Repeats do not move it, and notifications stop moving it once a record is past its limit of 20, so a flood cannot keep every form out of date.
* **A report that cannot be recorded is not acknowledged.** The notification route answers 503, so PayTech can retry. A notification about to complete a payment is recorded first, and nothing completes if it cannot be.
* **An alert every address refused stays due.** The sweep tries again, and the queue shows the record regardless. An address that refuses while another accepts is logged and next hears at the weekly reminder, so that it cannot re-mail the others on every run. A different report or a changed answer arriving while an alert goes out stays due too. Delivery is at least once, so reports arriving together can send more than one. Alerts and escalation run before anything that needs PayTech, and no new alert starts past a share of the sweep's time. A record still waiting for a person, which means open, flagged or holding a different report nobody has reviewed, is alerted on again a week after its last alert. The same notification again is not that. Where payments can be processed, or a record is waiting for a person, the admin page warns if the sweep has not finished recently, or if nobody is configured to receive alerts. A run stopped at its time budget, or in which escalation or writing a report failed, does not count as finished.
* **The sweep looks beyond what is in flight.** With a confirmed contract it also asks about closed and completed payments created in the last 30 days, and about the newest 200 attempts a person closed whatever their age, a bounded number of each per run. On those it can only add to the record. A reversal of a payment created more than 30 days ago is not looked for.
* **Checkout refuses a new attempt** while an open record or an unreviewed flag concerns that learner and course, because a second attempt could take the money twice. It does not refuse because of a record on a completed payment, or one that began with a report that failed its check and has gained nothing since but more such reports, a cancellation or the provider's "not paid". It checks again after the provider call, before any URL is handed out. If it cannot check, it opens nothing.

## Applying it

Migration `064_payment_exceptions.sql` requires migrations through 063, refuses to run otherwise, and tests itself in a transaction that it rolls back. The operator steps and rollback are at the foot of the file. The rollback refuses while any record is open, watching, flagged, holding counted notifications or owed an alert, because dropping the table would destroy the record of money that may be owed. Roll back 064 before 063, and export resolved records first.

Apply it before this code takes real payments. Without it, the code fails closed: checkout refuses and the notification route answers 503.

## What this evidence does not prove

* How PayTech behaves. The provider is simulated, and its retry policy and refund options are unconfirmed.
* That a refund happened. A recorded refund is an administrator's statement, and this system cannot verify it.
* Delivery of a real alert email. The sender is simulated in these tests.
* Lock contention between two database sessions. PGlite has one connection.

This workflow supports reconciliation against the PayTech dashboard, and does not replace it.
