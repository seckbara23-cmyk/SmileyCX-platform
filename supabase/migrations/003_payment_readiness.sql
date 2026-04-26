-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — Payment Readiness Schema Additions
-- Prepares the database for Wave / Orange Money / Stripe integration.
-- Run after 001_phase_a_rls_fix.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Add webhook_id column for idempotent payment callbacks
ALTER TABLE payments ADD COLUMN IF NOT EXISTS webhook_id TEXT UNIQUE;

-- Add payment_intent_id for Stripe
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;

-- Add failure_reason for failed payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- Index for fast webhook lookup
CREATE INDEX IF NOT EXISTS payments_webhook_idx     ON payments(webhook_id) WHERE webhook_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_reference_idx   ON payments(reference);
CREATE INDEX IF NOT EXISTS payments_status_idx      ON payments(status);
CREATE INDEX IF NOT EXISTS payments_user_status_idx ON payments(user_id, status);

-- ── Auto-enroll on payment completion ────────────────────────────────────────
-- This function is called by a webhook route (or background job) when a payment
-- is confirmed. It atomically marks the payment complete and creates enrollment.
CREATE OR REPLACE FUNCTION complete_payment(
  p_payment_reference TEXT,
  p_provider_reference TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment payments%ROWTYPE;
  v_enroll_id UUID;
BEGIN
  -- Lock and fetch the payment
  SELECT * INTO v_payment
  FROM payments
  WHERE reference = p_payment_reference
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payment not found');
  END IF;

  IF v_payment.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'already_completed', true);
  END IF;

  IF v_payment.status NOT IN ('pending', 'processing') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Payment in non-completable state: ' || v_payment.status);
  END IF;

  -- Mark payment complete
  UPDATE payments
  SET
    status             = 'completed',
    provider_reference = COALESCE(p_provider_reference, provider_reference),
    completed_at       = NOW(),
    updated_at         = NOW()
  WHERE id = v_payment.id;

  -- Create enrollment (skip if already exists)
  INSERT INTO enrollments (user_id, course_id, payment_id, status)
  VALUES (v_payment.user_id, v_payment.course_id, v_payment.id, 'active')
  ON CONFLICT (user_id, course_id) DO UPDATE
    SET status = 'active', payment_id = v_payment.id
  RETURNING id INTO v_enroll_id;

  RETURN jsonb_build_object(
    'ok',           true,
    'payment_id',   v_payment.id,
    'enrollment_id', v_enroll_id
  );
END;
$$;

-- ── NOTES FOR INTEGRATION ────────────────────────────────────────────────────
--
-- WAVE (wave.com/v1):
--   1. POST /checkout/sessions → get checkout_url
--   2. Redirect user to checkout_url
--   3. Wave POSTs to your webhook: POST /api/webhooks/wave
--   4. Verify signature (Wave-Signature header)
--   5. Call SELECT complete_payment(reference, wave_transaction_id)
--
-- ORANGE MONEY (orange-money-webpay):
--   1. POST /orange-money-webpay/dev/v1/webpayment → get payment_url
--   2. Redirect user to payment_url
--   3. Orange Money calls notif_url: POST /api/webhooks/orange-money
--   4. Verify status field === "SUCCESS"
--   5. Call SELECT complete_payment(order_id, txnid)
--
-- STRIPE:
--   1. POST /v1/payment_intents → create intent
--   2. Frontend uses Stripe.js to confirm payment
--   3. Stripe POSTs to webhook: POST /api/webhooks/stripe
--   4. Verify stripe-signature header with stripe.webhooks.constructEvent()
--   5. Handle payment_intent.succeeded event
--   6. Call SELECT complete_payment(metadata.reference, payment_intent.id)
--
-- BEST INTEGRATION POINTS IN CODE:
--   - /app/(platform)/checkout/page.tsx — initiate payment
--   - /app/api/webhooks/[provider]/route.ts — handle callbacks (to create)
--   - lib/payments/ — payment provider clients (to create)
--   - complete_payment() SQL function — atomic enrollment creation
-- ─────────────────────────────────────────────────────────────────────────────
