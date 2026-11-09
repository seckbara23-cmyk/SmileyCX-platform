# PayTech `GET /payment/get-status` answers, as observed

Sanitised copies of what PayTech's test environment answered on 2026-11-07 (XP-LAUNCH-04), read by `xp-launch-04-settlement-contract.test.ts`:

| File | What was asked about | Observed |
|---|---|---|
| `paid.json` | a checkout paid with Wave, asked twice half an hour after the debit (identical answers) | `success: 1`, `payment.state: "success"`, the item price in `item_price` and `item_price_xof`, our reference in `ref_command` |
| `running.json` | an unpaid checkout (fresh, and two hours old) and a checkout cancelled with PayTech's « Annuler » button (asked right after) | `success: 1`, `payment.state: "running"`, buyer fields and `date_checkout` null |
| `unknown-token.json` | a token PayTech never issued | `success: 0`, `payment: null` |

Field names, types, nesting and status words are exactly as answered. Our reference, the token, the titles, the timestamps and the buyer's name and phone number are placeholders. The real answers carry **no** `Content-Type` header; the test reproduces that. No answer carried a currency field, a `token_expire_at` value, or a word for a failed or cancelled payment.
