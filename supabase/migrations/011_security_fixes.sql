-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — 011: Critical Pilot Security Fixes
-- ═══════════════════════════════════════════════════════════════════════════
-- Addresses:
--   1. Distributed rate limiting: Supabase-backed rate_limits table
--   2. Quiz integrity: add module_id to quiz_attempts; restrict INSERT to
--      service role so scores can only be recorded by the server action
--   3. Payment integrity: remove client-side INSERT permission on payments
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Rate limits table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT        PRIMARY KEY,
  count        INTEGER     NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL
);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- No user-level access — only the service-role client reads this table.
DROP POLICY IF EXISTS "rate_limits_no_user_access" ON rate_limits;
CREATE POLICY "rate_limits_no_user_access"
  ON rate_limits FOR ALL
  USING (false) WITH CHECK (false);

CREATE INDEX IF NOT EXISTS rate_limits_expires_idx ON rate_limits(expires_at);


-- ── 2. Atomic rate-limit check (SQL function) ─────────────────────────────────
-- Called from the admin login API route via admin_client.rpc('check_rate_limit').
-- Performs an atomic INSERT … ON CONFLICT DO UPDATE so concurrent serverless
-- invocations see a consistent count. Handles window expiry inline.

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key       TEXT,
  p_limit     INTEGER,
  p_window_ms BIGINT      -- window duration in milliseconds
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count      INTEGER;
  v_expires_at TIMESTAMPTZ;
  v_now        TIMESTAMPTZ := NOW();
  v_window_end TIMESTAMPTZ := v_now + (p_window_ms * INTERVAL '1 millisecond');
BEGIN
  INSERT INTO rate_limits (key, count, window_start, expires_at)
  VALUES (p_key, 1, v_now, v_window_end)
  ON CONFLICT (key) DO UPDATE
    SET
      count        = CASE
                       WHEN rate_limits.expires_at < v_now THEN 1
                       ELSE rate_limits.count + 1
                     END,
      window_start = CASE
                       WHEN rate_limits.expires_at < v_now THEN v_now
                       ELSE rate_limits.window_start
                     END,
      expires_at   = CASE
                       WHEN rate_limits.expires_at < v_now THEN v_window_end
                       ELSE rate_limits.expires_at
                     END
  RETURNING count, expires_at INTO v_count, v_expires_at;

  -- Probabilistic cleanup (~1% of calls) to keep the table small.
  IF random() < 0.01 THEN
    DELETE FROM rate_limits WHERE expires_at < v_now;
  END IF;

  RETURN jsonb_build_object(
    'success',  v_count <= p_limit,
    'count',    v_count,
    'limit',    p_limit,
    'reset_at', (EXTRACT(EPOCH FROM v_expires_at) * 1000)::BIGINT
  );
END;
$$;


-- ── 3. Quiz attempts: add module_id ───────────────────────────────────────────
-- Needed for efficient module-level pass-state lookups from the lesson player
-- and certificate page without a multi-hop join through quizzes.

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS module_id UUID REFERENCES modules(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS quiz_attempts_user_module_passed_idx
  ON quiz_attempts(user_id, module_id) WHERE passed = true;

CREATE INDEX IF NOT EXISTS quiz_attempts_user_quiz_idx
  ON quiz_attempts(user_id, quiz_id);


-- ── 4. Quiz attempts RLS: restrict INSERT to service role ─────────────────────
-- The old FOR ALL policy allowed authenticated clients to INSERT arbitrary rows.
-- Server actions (using the admin/service-role client, which bypasses RLS)
-- are now the only insert path, ensuring scores are always computed server-side.

DROP POLICY IF EXISTS "attempts_own"           ON quiz_attempts;
DROP POLICY IF EXISTS "attempts_select_own"    ON quiz_attempts;
DROP POLICY IF EXISTS "attempts_insert_service" ON quiz_attempts;
DROP POLICY IF EXISTS "attempts_admin_all"     ON quiz_attempts;

-- Users can read their own past attempts (for "already passed" UI state).
CREATE POLICY "attempts_select_own"
  ON quiz_attempts FOR SELECT
  USING (user_id = auth.uid() OR is_platform_admin());

-- No direct INSERT from the browser — service role (admin client) bypasses RLS.
CREATE POLICY "attempts_insert_service"
  ON quiz_attempts FOR INSERT
  WITH CHECK (false);

-- Admins retain full access.
CREATE POLICY "attempts_admin_all"
  ON quiz_attempts FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());


-- ── 5. Payments RLS: restrict INSERT to service role ─────────────────────────
-- Removes the policy that allowed authenticated clients to INSERT payment rows
-- directly from the browser. All payment creation must now go through server
-- actions or webhook handlers that use the service-role client and validate
-- the amount against the database.

DROP POLICY IF EXISTS "payments_insert_own"     ON payments;
DROP POLICY IF EXISTS "payments_insert_service" ON payments;

-- No direct INSERT from the browser.
CREATE POLICY "payments_insert_service"
  ON payments FOR INSERT
  WITH CHECK (false);


-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('rate_limits', 'quiz_attempts', 'payments')
ORDER BY tablename, policyname;
