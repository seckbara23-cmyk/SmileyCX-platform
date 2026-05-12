-- Migration 020: Pilot feedback table
-- Collects structured learner feedback after course completion.

CREATE TABLE IF NOT EXISTS pilot_feedback (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  course_id               uuid        NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  clarity_rating          smallint    NOT NULL CHECK (clarity_rating BETWEEN 1 AND 5),
  practical_value_rating  smallint    NOT NULL CHECK (practical_value_rating BETWEEN 1 AND 5),
  ease_of_use_rating      smallint    NOT NULL CHECK (ease_of_use_rating BETWEEN 1 AND 5),
  most_useful             text,
  confusing_part          text,
  would_recommend         boolean,
  fair_price              text,
  comment                 text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pilot_feedback_course_idx  ON pilot_feedback(course_id);
CREATE INDEX IF NOT EXISTS pilot_feedback_user_idx    ON pilot_feedback(user_id);
CREATE INDEX IF NOT EXISTS pilot_feedback_created_idx ON pilot_feedback(created_at DESC);

-- RLS
ALTER TABLE pilot_feedback ENABLE ROW LEVEL SECURITY;

-- Authenticated learners can insert their own feedback
CREATE POLICY "learners_insert_feedback"
ON pilot_feedback FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

-- Anonymous users (PILOT_MODE) can insert with null user_id
CREATE POLICY "anon_insert_feedback"
ON pilot_feedback FOR INSERT TO anon
WITH CHECK (user_id IS NULL);

-- No SELECT policy for learners — admin reads via service role (bypasses RLS)
