# XP-LAUNCH-FINAL-08 — commercial offers: prices, packs and six-month access

Builds on the PayTech payment integration merged in PR #61. Apply migration 065 after 063 and 064, and before this change is deployed.

## What was decided

The commercial conditions confirmed in writing for launch (requirements V4):

| Offer | Content | Price (FCFA) |
|---|---|---:|
| C1-F1, C1-F2, C1-F3 | one course each | 9 900 |
| C2-F4, C2-F1, C2-F2, C2-F5 | one course each | 14 900 |
| C1-F4 | free course | 0 |
| Pack Conseiller | C1-F1 + C1-F2 + C1-F3 + C2-F4 | 37 900 |
| Pack Manager | C2-F1 + C2-F2 + C2-F5 | 38 000 |
| Pack Entreprises | courses chosen by the company, licences | on quotation |

* A paid purchase gives access for **six calendar months from the validation of the payment**, activated automatically.
* All courses of a pack open at the same instant and close together.
* A course already owned inside a pack is neither refunded nor replaced; the learner is warned before paying.
* A purchase whose window has closed can be bought again.
* The free course, administrative and corporate grants are unchanged. A certificate stays valid and verifiable after access ends.
* The V8 job-role and industry pathways stay configured but are hidden from the public interface.

## Migration 065 (`supabase/migrations/065_commercial_offers.sql`)

One transaction, after 063 and 064. 062 is not edited: four functions are replaced in place.

* `course_packs` and `course_pack_courses`: published packs readable by anyone, writes for `service_role` only; seeded with the two packs by course code. A pack's composition is frozen while a payment for it is in flight.
* `payments.pack_id`: a payment buys one course or one pack, never both. Not granted to any browser role.
* **One payable attempt per learner and course, across packs and single courses**: a unique index per learner and pack in flight, beside the existing one per course, and a trigger that refuses an in-flight attempt overlapping another one of the same learner, serialised per learner.
* `payment_entitlements`: per completed payment and course, the entitlement granted or linked. `service_role` only.
* `complete_payment()` replaced: 062's verification steps unchanged except that a pack payment carries no course; then, per course, an expired purchase is rolled over to `EXPIRED`, an accessible entitlement of any source is linked and never re-dated, or one `INDIVIDUAL_PURCHASE` is granted for six months from now; delivery is verified; the enrollment is ensured without duplication; the link is recorded.
* `payment_exception_decide`, `payment_exception_record_refund` and `payment_exception_blocking_reference` replaced by one edit each, so that an exception on a pack payment concerns the pack's courses.
* Its rollback block restores 062's and 064's functions verbatim and refuses while any pack payment or recorded completion exists.

## Application

* `startPaytechPackCheckout`: the server derives the pack's price and courses, what the learner owns, every in-flight attempt that would open one of the courses, and requires the learner to acknowledge exactly the owned courses it finds. The single-course checkout also settles an in-flight pack containing the course. An opened attempt is never superseded on a guess; a pending one is resumed.
* Pages: three offer cards on the home page and the catalogue, a public page per pack, the pack checkout with its warning, « Accès 6 mois » wherever the site said « à vie », « Renouveler mon accès » after expiry, the access end date on the payment confirmation, pack payments named on the cancel page, the admin list and the exception queue.
* Pathways hidden by one flag (`lib/catalogue/visibility.ts`): navigation, course-page section, public pages, sitemap.
* `scripts/security/verify-commercial-offers.mjs`: a read-only check, with the public key, that the published prices and packs match the table above.

## Prices

Course prices live in the database and are changed in the administration's course editor, which does not audit a price change by itself. Run the verifier before and after the change; its two outputs are the record. Checkout, PayTech's amount and every page read the same database price.

## Tests

* The PostgreSQL integration suite applies 065 whole after 063 and 064, so its existing payment tests run against the new `complete_payment()`. New cases cover the eight prices, the six-month window, both packs, the owned-course warning, all-owned refusal, administrative grants, renewal after expiry, overlap in both directions and in the database alone, the pack resume, the composition freeze, `pack_id` immutability, and exceptions on a pack payment.
* Interface tests cover the three offers, the pack page, the pack checkout and its lock, the six-month wording, the hidden pathways and certificates after expiry.

## Release order

1. PR #61 merged and deployed with checkout off (done); 063, then 064.
2. 065 applied under its own gate, after a completed nightly backup.
3. This PR merged and deployed, checkout still off.
4. Course prices set in the administration; the verifier passes.
5. PayTech production configuration and activation, as for PR #61.

