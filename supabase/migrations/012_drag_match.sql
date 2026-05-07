-- Add drag-and-match question type support to quiz_questions.
-- Safe to run on existing data: all defaults preserve current behaviour.

-- 1. Question type discriminator
ALTER TABLE quiz_questions
  ADD COLUMN IF NOT EXISTS question_type TEXT NOT NULL DEFAULT 'multiple_choice'
    CHECK (question_type IN ('multiple_choice', 'drag_match'));

-- 2. Server-side correct-answer map for drag_match questions.
--    { itemId: categoryId }  — never selected by learner-facing queries.
ALTER TABLE quiz_questions
  ADD COLUMN IF NOT EXISTS drag_match_answers JSONB NULL;

-- 3. Make correct_answer nullable so drag_match rows can store NULL here.
ALTER TABLE quiz_questions
  ALTER COLUMN correct_answer DROP NOT NULL;

-- 4. Index to speed admin queries filtering by type.
CREATE INDEX IF NOT EXISTS quiz_questions_type_idx
  ON quiz_questions (quiz_id, question_type);
