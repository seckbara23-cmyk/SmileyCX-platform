# XP-PAYTECH-READY-01: audit summary

This is the summary of the audit behind [XP-PAYTECH-04](XP-PAYTECH-04-PULL-REQUEST.md).

* **Audited code:** `main` at `e90746b`.
* **Method:** code review plus isolated tests on a local PostgreSQL engine with a simulated provider. No payment was made and no PayTech request was sent.

## Findings

| ID | Finding | Status |
|---|---|---|
| C1 | Checkout was not connected to PayTech | Closed |
| C2 | The legacy checkout form could collect card details | Closed: the form is deleted |
| P1 | Settlement depended on a provider response PayTech does not document | Closed in code: fails closed until PayTech confirms the response |
| F8 | Notification checks depend on provider details PayTech does not fully document | Closed in code: fails closed until PayTech confirms them |
| F1 | A checkout retry could lose track of an earlier attempt | Closed |
| F2 | A retry racing a completion could corrupt a payment record | Closed |
| P2 | Nothing reconciled an unresolved payment | Closed |
| E1 | Test and live modes were not separated by environment | Closed |
| E3 | A callback override was accepted in production | Closed |
| F3 | Checkout and completion applied different eligibility rules | Closed |
| F4 | A payment marked closed can still be paid at the provider, with nothing granted and no alert | **Open: mandatory blocker before live payments.** A workflow is built in [XP-PAYTECH-05](XP-PAYTECH-05-LATE-PAID-EXCEPTIONS.md), but it is not applied, not exercised with PayTech, and the refund policy is undecided |
| A1 | The admin view mislabelled payment states | Closed |
| K1 | One switch controlled both new sales and existing payments | Closed |
| X1 | Abandoned payment intents never expired | Closed |
| F6 | The completion result was misread | Closed |
| D1 | Some code documentation and page text had drifted | Closed |

## Scenarios exercised

All fifteen run against the real checkout action, notification route and completion SQL. Results below are for this branch. The tests are in `__tests__/payments/xp-paytech-ready-01-integration.test.ts`.

| # | Scenario | Tests | Result |
|---|---|---|---|
| 1 | Successful payment | T01 | Pass |
| 2 | Failed payment | T02 | Pass |
| 3 | Cancelled payment | T03 | Pass |
| 4 | Pending payment | T04 | Pass |
| 5 | Forged notification | T05 | Pass |
| 6 | Incorrect amount | T06 | Pass |
| 7 | Incorrect course identifier | T07 | Pass |
| 8 | Incorrect user identifier | T07, T08 | Pass |
| 9 | Duplicate notification | T09 | Pass |
| 10 | Replayed transaction | T10 | Pass |
| 11 | Expired or invalid transaction | T11 | Pass |
| 12 | Database failure during entitlement creation | T12 | Pass |
| 13 | Concurrent notifications | T13 | Pass |
| 14 | Unauthorized direct enrolment | T14 | Pass |
| 15 | Unauthorized payment status modification | T15 | Pass |

## What this evidence does not prove

* How PayTech actually behaves. The provider is simulated.
* That a late payment would be found without a notification. That needs the settlement contract.
* How a deployed system behaves. These tests run locally.
* How two separate database sessions contend for a lock. PGlite has one connection.
