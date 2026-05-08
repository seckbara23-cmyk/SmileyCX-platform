-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — 013: Pilot quiz types, certificates, course intro videos
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds:
--   1. Extended question_type CHECK: multiple_answer, true_false, visual_choice
--   2. question_image_url column for visual_choice questions
--   3. certificates table (COC — Certificate of Completion)
--   4. intro_video_url column on courses


-- ── 1. Extend question_type CHECK ─────────────────────────────────────────────

ALTER TABLE quiz_questions
  DROP CONSTRAINT IF EXISTS quiz_questions_question_type_check;

ALTER TABLE quiz_questions
  ADD CONSTRAINT quiz_questions_question_type_check
  CHECK (question_type IN (
    'multiple_choice',
    'multiple_answer',
    'true_false',
    'drag_match',
    'visual_choice'
  ));


-- ── 2. question_image_url for visual_choice ───────────────────────────────────

ALTER TABLE quiz_questions
  ADD COLUMN IF NOT EXISTS question_image_url TEXT;


-- ── 3. Certificates table (Certificate of Completion) ─────────────────────────
-- One certificate per (user, course) pair.
-- Issued server-side when all module quizzes for the course are passed.
-- certificate_number is a human-readable unique ID shown on the certificate.

CREATE TABLE IF NOT EXISTS certificates (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id          UUID        NOT NULL REFERENCES courses(id)  ON DELETE CASCADE,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  certificate_number TEXT        NOT NULL UNIQUE,
  UNIQUE (user_id, course_id)
);

ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;

-- Learners can view their own certificates (for display / download).
DROP POLICY IF EXISTS "certificates_select_own"  ON certificates;
CREATE POLICY "certificates_select_own"
  ON certificates FOR SELECT
  USING (user_id = auth.uid() OR is_platform_admin());

-- Authenticated users may insert their own certificate (eligibility is enforced server-side).
DROP POLICY IF EXISTS "certificates_insert_service" ON certificates;
DROP POLICY IF EXISTS "certificates_insert_auth"    ON certificates;
CREATE POLICY "certificates_insert_auth"
  ON certificates FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Admins retain full access.
DROP POLICY IF EXISTS "certificates_admin_all" ON certificates;
CREATE POLICY "certificates_admin_all"
  ON certificates FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

CREATE INDEX IF NOT EXISTS certificates_user_course_idx
  ON certificates (user_id, course_id);


-- ── 4. Intro video URL on courses ─────────────────────────────────────────────

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS intro_video_url TEXT;
