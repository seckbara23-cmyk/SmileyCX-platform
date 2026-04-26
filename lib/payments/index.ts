/**
 * SmileyCX Academy — Payment Service Layer (Pilot Mode)
 *
 * ⚠️ PILOT MODE: No real payment gateways are wired yet.
 * All payment methods currently return explicit errors.
 * Enrollment activation is NOT YET IMPLEMENTED — payments remain in 'pending' state.
 *
 * This file defines interfaces and stubs ready for live payment integration.
 * Each gateway (Orange Money, Wave, Stripe) has a TODO section showing integration points.
 *
 * Intended Flow (when live):
 *  1. Client calls initiatePayment() → redirects to gateway
 *  2. Gateway processes payment asynchronously
 *  3. Webhook at /api/payments/webhook/[method] confirms payment server-side
 *  4. Webhook calls unlockEnrollment() to activate learner access
 *
 * Current Safeguards:
 *  - All initiate functions return error to user
 *  - All verify functions return 'pending' (no 'completed' state)
 *  - unlockEnrollment() is not wired to anything
 *  ⟹ IMPOSSIBLE to accidentally grant access in pilot mode
 */

import type { PaymentMethod, PaymentStatus } from '@/types/index'

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentInitParams {
  reference: string       // internal SCX-XXXXXXXX reference
  courseId:  string
  userId:    string
  amount:    number       // in XOF (or currency below)
  currency:  string       // 'XOF' | 'USD' | etc.
  method:    PaymentMethod
  phone?:    string       // required for Orange Money / Wave
  returnUrl: string       // where to redirect after payment
  webhookUrl: string      // where gateway posts payment status
}

export interface PaymentInitResult {
  success:      boolean
  paymentUrl?:  string   // redirect URL for gateways that need it
  providerRef?: string   // gateway's own reference
  error?:       string
}

export interface PaymentVerifyResult {
  status:       PaymentStatus
  providerRef?: string
  rawResponse?: unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Orange Money (PILOT MODE — NOT YET LIVE)
// Docs: https://developer.orange.com/apis/om-webpay-prod/getting-started
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ PILOT: Returns error. Real implementation pending.
 * This stub ensures payments cannot be initiated until live.
 */
export async function initiateOrangeMoney(
  params: PaymentInitParams
): Promise<PaymentInitResult> {
  // TODO: Implement Orange Money WebPay integration
  //
  // Prerequisites:
  //   - Add env vars to .env.local:
  //       ORANGE_MONEY_CLIENT_ID
  //       ORANGE_MONEY_CLIENT_SECRET
  //       ORANGE_MONEY_BASE_URL (e.g., https://developer.orange.com/orangemoney/prod)
  //   - Set up webhook route: POST /api/payments/webhook/orange-money
  //
  // Implementation steps:
  //   1. POST {ORANGE_MONEY_BASE_URL}/token with credentials → get Bearer token
  //   2. POST {ORANGE_MONEY_BASE_URL}/webpayment with:
  //      { merchant_key, currency, order_id, amount, return_url, cancel_url, notif_url, lang, reference }
  //   3. Extract payment_url from response
  //   4. Return { success: true, paymentUrl: payment_url, providerRef: order_id }
  //   5. Store providerRef in payments table for later webhook verification
  //
  // Remove this console.warn once live:
  console.warn(
    '[PILOT] Orange Money payment requested but not yet live. ' +
    'Enable in initiateOrangeMoney() when merchant credentials are active.'
  )

  return {
    success: false,
    error:   '[PILOT] Orange Money payments not yet enabled. Please contact support.',
  }
}

/**
 * ⚠️ PILOT: Returns 'pending'. Should be called by webhook handler.
 * Currently unreachable since initiateOrangeMoney() always fails.
 */
export async function verifyOrangeMoney(
  providerRef: string
): Promise<PaymentVerifyResult> {
  // TODO: Verify payment status from Orange Money
  //
  // Implementation:
  //   1. GET {ORANGE_MONEY_BASE_URL}/webpayment/{providerRef}/status
  //      with Authorization header
  //   2. Parse response for payment status (pending, completed, failed)
  //   3. Return { status, providerRef, rawResponse }
  //
  // Called by webhook at /api/payments/webhook/orange-money

  console.warn('[PILOT] verifyOrangeMoney called but not yet implemented')
  return { status: 'pending' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave (PILOT MODE — NOT YET LIVE)
// Docs: https://docs.wave.com/business/api
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ PILOT: Returns error. Real implementation pending.
 * This stub ensures payments cannot be initiated until live.
 */
export async function initiateWave(
  params: PaymentInitParams
): Promise<PaymentInitResult> {
  // TODO: Implement Wave Checkout integration
  //
  // Prerequisites:
  //   - Add env vars to .env.local:
  //       WAVE_API_KEY (from Wave dashboard)
  //       WAVE_BASE_URL (e.g., https://api.wave.com/v1)
  //   - Set up webhook route: POST /api/payments/webhook/wave
  //
  // Implementation steps:
  //   1. POST {WAVE_BASE_URL}/checkout/sessions with:
  //      { amount: params.amount * 100, currency: params.currency, success_url,
  //        error_url, customer_reference: params.reference }
  //   2. Extract checkout_url from response
  //   3. Extract session_id (Wave's internal reference)
  //   4. Return { success: true, paymentUrl: checkout_url, providerRef: session_id }
  //   5. Store providerRef in payments.provider_reference
  //
  // Remove this console.warn once live:
  console.warn(
    '[PILOT] Wave payment requested but not yet live. ' +
    'Enable in initiateWave() when merchant API key is active.'
  )

  return {
    success: false,
    error:   '[PILOT] Wave payments not yet enabled. Please contact support.',
  }
}

/**
 * ⚠️ PILOT: Returns 'pending'. Should be called by webhook handler.
 * Currently unreachable since initiateWave() always fails.
 */
export async function verifyWave(
  sessionId: string
): Promise<PaymentVerifyResult> {
  // TODO: Verify payment status from Wave
  //
  // Implementation:
  //   1. GET {WAVE_BASE_URL}/checkout/sessions/{sessionId}
  //      with Authorization header (Bearer {WAVE_API_KEY})
  //   2. Parse response for payment.status (pending, completed, canceled, failed)
  //   3. Return { status, providerRef: sessionId, rawResponse }
  //
  // Called by webhook at /api/payments/webhook/wave

  console.warn('[PILOT] verifyWave called but not yet implemented')
  return { status: 'pending' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe Card Payments (PILOT MODE — NOT YET LIVE)
// Docs: https://stripe.com/docs/payments/accept-card-payments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ PILOT: Returns error. Real implementation pending.
 * This stub ensures card payments cannot be initiated until live.
 */
export async function initiateStripe(
  params: PaymentInitParams
): Promise<PaymentInitResult> {
  // TODO: Implement Stripe Payment Intent or Checkout Session
  //
  // Prerequisites:
  //   - Add env vars to .env.local:
  //       STRIPE_SECRET_KEY (from Stripe dashboard)
  //       NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (client-side)
  //   - Set up webhook route: POST /api/payments/webhook/stripe
  //   - Install @stripe/stripe-js if using Checkout
  //
  // Implementation options:
  //
  // Option A — Server-side Checkout Session (simpler):
  //   1. POST https://api.stripe.com/v1/checkout/sessions with:
  //      { line_items: [{ price_data: { amount, currency }, quantity: 1 }],
  //        payment_method_types: ['card'], success_url, cancel_url, mode: 'payment' }
  //   2. Extract session_id and session.url from response
  //   3. Return { success: true, paymentUrl: session.url, providerRef: session_id }
  //
  // Option B — Payment Intent + Stripe.js (direct card input):
  //   1. POST https://api.stripe.com/v1/payment_intents with { amount, currency, metadata }
  //   2. Return client_secret to client
  //   3. Client uses @stripe/react-stripe-js to complete payment
  //   4. Return { success: true, providerRef: intent_id }
  //
  // Remove this console.warn once live:
  console.warn(
    '[PILOT] Stripe card payment requested but not yet live. ' +
    'Enable in initiateStripe() when Stripe credentials are configured.'
  )

  return {
    success: false,
    error:   '[PILOT] Card payments not yet enabled. Please contact support.',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router — dispatch to the appropriate payment gateway
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route payment initialization to the correct gateway.
 * Currently all gateways return errors in pilot mode.
 */
export async function initiatePayment(
  params: PaymentInitParams
): Promise<PaymentInitResult> {
  switch (params.method) {
    case 'orange_money':
      return initiateOrangeMoney(params)
    case 'wave':
      return initiateWave(params)
    case 'card':
      return initiateStripe(params)
    default:
      return {
        success: false,
        error: `Unsupported payment method: ${params.method}`,
      }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment Unlock (PILOT MODE — NOT YET WIRED)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ PILOT: Enrollment activation is stubbed and returns error.
 * This function is NOT CALLED by anything in the current flow.
 *
 * This should be invoked ONLY by:
 *   - Webhook handlers (server-side) at /api/payments/webhook/[gateway]
 *   - AFTER the payment gateway confirms successful payment
 *   - WITH verified payment status from gateway (never from client)
 *
 * Uses admin Supabase client to bypass RLS and update system state.
 */
export async function unlockEnrollment(params: {
  userId:    string
  courseId:  string
  paymentId: string
}): Promise<{ success: boolean; error?: string }> {
  // TODO: Implement server-side enrollment activation
  // ONLY call this from webhook handlers after payment confirmation.
  //
  // Import: import { createAdminClient } from '@/lib/supabase/admin'
  //
  // Implementation:
  //   1. Verify the payment exists and belongs to userId:
  //      SELECT * FROM payments WHERE id = paymentId AND user_id = userId
  //   2. Update payment to 'completed':
  //      UPDATE payments SET status = 'completed', completed_at = now()
  //      WHERE id = paymentId
  //   3. Create/update enrollment:
  //      UPSERT enrollments (user_id, course_id, status = 'active', payment_id)
  //   4. (Optional) Log the event for auditing
  //   5. (Optional) Schedule welcome email
  //   6. Return { success: true }
  //
  // CRITICAL: Only call after gateway-confirmed payment completion.
  // Never call from client-side code.

  console.warn(
    '[PILOT] unlockEnrollment called but not yet implemented. ' +
    'This should only be called from webhook handlers after gateway confirmation. ' +
    'PaymentId:', params.paymentId
  )
  return {
    success: false,
    error: '[PILOT] Enrollment unlock not yet implemented. Set up webhook handlers.',
  }
}
