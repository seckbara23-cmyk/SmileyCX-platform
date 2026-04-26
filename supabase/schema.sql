-- ═══════════════════════════════════════════════════════════════════
-- SmileyCX Platform — Supabase Database Schema
-- ═══════════════════════════════════════════════════════════════════
-- Run this in Supabase SQL Editor to bootstrap the database.
-- Supabase handles auth.users automatically; we extend with profiles.

-- ── Enable UUID extension ────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Profiles (extends auth.users) ────────────────────────────────────
CREATE TABLE profiles (
  id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  full_name      TEXT,
  avatar_url     TEXT,
  platform_role  TEXT NOT NULL DEFAULT 'user'
                   CHECK (platform_role IN ('user', 'super_admin', 'consultant')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, platform_role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'user'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── Courses ───────────────────────────────────────────────────────────
CREATE TABLE courses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  title_fr         TEXT,
  description      TEXT NOT NULL,
  description_fr   TEXT,
  thumbnail_url    TEXT,
  price            DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'XOF',
  is_published     BOOLEAN NOT NULL DEFAULT false,
  is_free          BOOLEAN NOT NULL DEFAULT false,
  level            TEXT NOT NULL DEFAULT 'beginner'
                     CHECK (level IN ('beginner','intermediate','advanced')),
  duration_hours   INTEGER,
  language         TEXT NOT NULL DEFAULT 'fr',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Modules ───────────────────────────────────────────────────────────
CREATE TABLE modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  title_fr    TEXT,
  description TEXT,
  order_index INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_id, slug)
);

-- ── Lessons ───────────────────────────────────────────────────────────
CREATE TABLE lessons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,
  title             TEXT NOT NULL,
  title_fr          TEXT,
  content           TEXT,
  video_url         TEXT,
  duration_minutes  INTEGER,
  order_index       INTEGER NOT NULL,
  is_preview        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(module_id, slug)
);

-- ── Quizzes ───────────────────────────────────────────────────────────
CREATE TABLE quizzes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id  UUID REFERENCES lessons(id) ON DELETE CASCADE,
  module_id  UUID REFERENCES modules(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE quiz_questions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id        UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  options        JSONB NOT NULL,    -- string[]
  correct_answer INTEGER NOT NULL,  -- index of correct option
  explanation    TEXT,
  order_index    INTEGER NOT NULL
);

-- ── Payments ──────────────────────────────────────────────────────────
CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES profiles(id) ON DELETE SET NULL,
  course_id          UUID REFERENCES courses(id) ON DELETE SET NULL,
  amount             DECIMAL(10,2) NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'XOF',
  method             TEXT NOT NULL
                       CHECK (method IN ('orange_money','wave','card')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','completed','failed','refunded')),
  reference          TEXT UNIQUE NOT NULL,
  provider_reference TEXT,
  metadata           JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

-- ── Enrollments ───────────────────────────────────────────────────────
CREATE TABLE enrollments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  payment_id  UUID REFERENCES payments(id) ON DELETE SET NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','expired','suspended')),
  UNIQUE(user_id, course_id)
);

-- ── Lesson Progress ───────────────────────────────────────────────────
CREATE TABLE lesson_progress (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lesson_id       UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  is_completed    BOOLEAN NOT NULL DEFAULT false,
  watched_seconds INTEGER NOT NULL DEFAULT 0,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, lesson_id)
);

-- ── Quiz Attempts ─────────────────────────────────────────────────────
CREATE TABLE quiz_attempts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  quiz_id    UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  answers    JSONB NOT NULL,
  score      INTEGER NOT NULL,
  max_score  INTEGER NOT NULL,
  passed     BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Certificates ──────────────────────────────────────────────────────
CREATE TABLE certificates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id          UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  certificate_number TEXT UNIQUE NOT NULL,
  UNIQUE(user_id, course_id)
);

-- ═══════════════════════════════════════════════════════════════════
-- Row Level Security (RLS)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE modules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lessons         ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_attempts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificates    ENABLE ROW LEVEL SECURITY;

-- Profiles: users see/edit only their own
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Platform admin sees everything
CREATE POLICY "profiles_admin_all" ON profiles FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

-- Published courses visible to all (including anonymous)
CREATE POLICY "courses_public_select" ON courses FOR SELECT USING (is_published = true);
CREATE POLICY "courses_admin_all"     ON courses FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

-- Modules & Lessons: visible if course is published OR user enrolled
CREATE POLICY "modules_visible" ON modules FOR SELECT
  USING (EXISTS (SELECT 1 FROM courses c WHERE c.id = course_id AND c.is_published = true));
CREATE POLICY "modules_admin_all" ON modules FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

CREATE POLICY "lessons_visible" ON lessons FOR SELECT
  USING (
    is_preview = true
    OR EXISTS (
      SELECT 1 FROM enrollments e
      JOIN modules m ON m.id = lessons.module_id
      WHERE e.user_id = auth.uid() AND e.course_id = m.course_id AND e.status = 'active'
    )
  );
CREATE POLICY "lessons_admin_all" ON lessons FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

-- Enrollments: own records only
CREATE POLICY "enrollments_own"      ON enrollments FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "enrollments_admin_all" ON enrollments FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

-- Payments: own records only
CREATE POLICY "payments_own"         ON payments FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "payments_insert_own"  ON payments FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "payments_admin_all"   ON payments FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

-- Progress: own only
CREATE POLICY "progress_own"    ON lesson_progress FOR ALL USING (user_id = auth.uid());
CREATE POLICY "attempts_own"    ON quiz_attempts   FOR ALL USING (user_id = auth.uid());
CREATE POLICY "certs_own"       ON certificates    FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "certs_admin_all" ON certificates    FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

-- ═══════════════════════════════════════════════════════════════════
-- Helper Views
-- ═══════════════════════════════════════════════════════════════════

-- Learner progress summary per course
CREATE OR REPLACE VIEW course_progress_view AS
SELECT
  e.user_id,
  e.course_id,
  COUNT(l.id)                                           AS total_lessons,
  COUNT(lp.id) FILTER (WHERE lp.is_completed = true)   AS completed_lessons,
  ROUND(
    COUNT(lp.id) FILTER (WHERE lp.is_completed = true)::numeric
    / NULLIF(COUNT(l.id), 0) * 100
  )                                                      AS percentage
FROM enrollments e
JOIN modules  m ON m.course_id = e.course_id
JOIN lessons  l ON l.module_id = m.id
LEFT JOIN lesson_progress lp
  ON lp.lesson_id = l.id AND lp.user_id = e.user_id
GROUP BY e.user_id, e.course_id;
