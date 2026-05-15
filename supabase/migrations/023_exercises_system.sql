-- Exercises: dedicated practice activities, separate from quizzes.
-- Quizzes = evaluation / pass-fail / certificates.
-- Exercises = optional practice reinforcement; no gating, no scoring impact.
-- MVP: lesson-scoped drag_match only. Architecture supports future types.

-- ── Tables ────────────────────────────────────────────────────────────────────

create table public.exercises (
  id            uuid primary key default gen_random_uuid(),
  lesson_id     uuid not null references public.lessons(id) on delete cascade,
  title         text not null,
  instructions  text,
  exercise_type text not null default 'drag_match'
                  check (exercise_type in ('drag_match')),
  is_published  boolean not null default false,
  order_index   integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.exercise_categories (
  id          uuid primary key default gen_random_uuid(),
  exercise_id uuid not null references public.exercises(id) on delete cascade,
  name        text not null,
  color       text,
  order_index integer not null default 0
);

create table public.exercise_items (
  id                  uuid primary key default gen_random_uuid(),
  exercise_id         uuid not null references public.exercises(id) on delete cascade,
  label               text not null,
  correct_category_id uuid not null references public.exercise_categories(id) on delete restrict,
  order_index         integer not null default 0
);

create table public.exercise_submissions (
  id           uuid primary key default gen_random_uuid(),
  exercise_id  uuid not null references public.exercises(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  score        integer not null default 0,
  completed    boolean not null default true,
  submitted_at timestamptz not null default now()
);

create table public.exercise_answers (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid not null references public.exercise_submissions(id) on delete cascade,
  exercise_item_id     uuid not null references public.exercise_items(id) on delete cascade,
  selected_category_id uuid references public.exercise_categories(id) on delete set null,
  is_correct           boolean not null default false
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

create index on public.exercises(lesson_id);
create index on public.exercise_categories(exercise_id, order_index);
create index on public.exercise_items(exercise_id, order_index);
create index on public.exercise_submissions(exercise_id, user_id);
create index on public.exercise_submissions(user_id);
create index on public.exercise_answers(submission_id);

-- ── Updated-at trigger ────────────────────────────────────────────────────────

create or replace function public.exercises_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger exercises_updated_at
  before update on public.exercises
  for each row execute procedure public.exercises_set_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────

alter table public.exercises            enable row level security;
alter table public.exercise_categories  enable row level security;
alter table public.exercise_items       enable row level security;
alter table public.exercise_submissions enable row level security;
alter table public.exercise_answers     enable row level security;

-- exercises: SELECT — published + (enrolled OR free/pilot course)
create policy "exercises_select" on public.exercises
  for select using (
    is_published = true
    and (
      public.is_platform_admin()
      or exists (
        select 1
        from public.lessons l
        join public.modules m on m.id = l.module_id
        join public.courses c on c.id = m.course_id
        where l.id = exercises.lesson_id
          and (
            c.is_free = true
            or exists (
              select 1 from public.enrollments e
              where e.user_id = auth.uid()
                and e.course_id = c.id
                and e.status = 'active'
            )
          )
      )
    )
  );

-- admin full access to exercises
create policy "exercises_admin" on public.exercises
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- exercise_categories: SELECT — parent exercise published or admin
create policy "exercise_categories_select" on public.exercise_categories
  for select using (
    public.is_platform_admin()
    or exists (
      select 1 from public.exercises ex
      where ex.id = exercise_categories.exercise_id
        and ex.is_published = true
    )
  );

create policy "exercise_categories_admin" on public.exercise_categories
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- exercise_items: SELECT — parent exercise published or admin
create policy "exercise_items_select" on public.exercise_items
  for select using (
    public.is_platform_admin()
    or exists (
      select 1 from public.exercises ex
      where ex.id = exercise_items.exercise_id
        and ex.is_published = true
    )
  );

create policy "exercise_items_admin" on public.exercise_items
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- exercise_submissions: learners own their rows; admins can read all
create policy "exercise_submissions_own" on public.exercise_submissions
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "exercise_submissions_admin_read" on public.exercise_submissions
  for select using (public.is_platform_admin());

-- exercise_answers: learners own via submission; admins can read all
create policy "exercise_answers_own" on public.exercise_answers
  for all using (
    exists (
      select 1 from public.exercise_submissions s
      where s.id = exercise_answers.submission_id
        and s.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.exercise_submissions s
      where s.id = exercise_answers.submission_id
        and s.user_id = auth.uid()
    )
  );

create policy "exercise_answers_admin_read" on public.exercise_answers
  for select using (public.is_platform_admin());
