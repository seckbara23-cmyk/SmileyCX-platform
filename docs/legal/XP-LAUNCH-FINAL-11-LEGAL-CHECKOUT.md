# XP-LAUNCH-FINAL-11: legal texts 1.0 and the checkout consent

Builds on the commercial offers (packs, six-month access). Merge after them.

## What changes

- **Four public legal pages at version 1.0**: CGU (`/terms`), CGV (`/cgv`), privacy policy (`/privacy`) and legal notice (`/mentions-legales`), linked from the footer and from each other. The texts are XP CLIENT's launch documents, transcribed word for word from their public parts; their internal working notes are left out. They are kept as data in `lib/legal/documents.ts` and rendered by one component.
- **Not lawyer-approved.** The texts were drafted with the help of AI tools and a lawyer's review is planned. The pages say a legal review is in progress and that any change will be published under a new version number. Nothing claims an approval.
- **Three unticked boxes before every purchase**, course or pack (CGV art. 4): acceptance of the CGU and CGV 1.0; the express request for immediate access, which states that it does not deprive the buyer of their statutory rights (CGV 7.1); and the certification of being 18 or older, or of buying as a parent or legal representative (CGV 9). The pay button stays locked until all three are ticked.
- **The server checks them again** before it reads anything or asks PayTech anything, resumes included. A page shown at an older version is refused and asked to reload.
- **The acceptance is recorded on the order**, `payments.metadata.legal`: the CGU and CGV versions, the two requests, and the server's time of acceptance.
- **Purchase confirmation e-mail** (CGV 4.4), sent once when a payment is completed: what was bought, the amount, the order reference, the six-month end date, for a pack its courses and which ones were already owned, and the conditions accepted. It is sent only on a fresh completion, never on a replay. A failed send is logged with the payment id only, and changes nothing about the payment or the access.
- Registration now records acceptance of CGU and privacy policy version 1.0.

## Tests

- 32 interface tests cover the texts, the four pages, the consent rule, the three boxes, the button lock and the e-mail.
- 6 database tests cover the refusal without the boxes, the record on course and pack orders, one e-mail per completion, a pack's e-mail and a failed send.
- The existing checkout tests now pass the three boxes.

## Open items that are decisions, not code

- CGU art. 6 ties the certificate to passing a final evaluation. Published courses issue it on completing the lessons.
- CGV art. 8 promises five voice-practice attempts per lesson with a visible counter, which is not built.
- Privacy policy art. 6 makes voice practice conditional on accepting the processing, and there is no consent step yet.
- CGV art. 11 says a receipt or invoice is issued for each sale. The confirmation e-mail is not an invoice, and invoices are sent on request.
