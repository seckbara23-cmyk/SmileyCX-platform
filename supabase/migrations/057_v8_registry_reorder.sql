-- ============================================================================
-- Migration 057 — CAT-ARCH-02: the V8 registry, and the display order V8 asks
--                 the learner to see.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- DATA ONLY. It creates no object, drops no object, and changes no privilege.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHAT THIS DOES, AND ON WHOSE AUTHORITY ─────────────────────────────────
--
-- CAT-ARCH-01 (056) made display order READABLE without opening the registry:
-- `public_catalogue_courses` publishes catalogue membership ordered by
-- `course_codes.position`, re-ranked 1..N over published courses only. It was
-- deliberately order-neutral — it changed nothing a visitor saw.
--
-- This migration is where the order actually moves, under owner rulings R1-R4
-- (approved 2026-09-26) against Marieme's "Architecture des catalogues et
-- parcours — Version 8":
--
--   R1   C1-F3's registry title becomes the LMS name V8 ratifies.
--        The registry said "Fondamentaux du service client digital" (the V4
--        architecture label); the course, the slug and every learner surface
--        have always said "Communiquer avec les clients sur les canaux
--        digitaux". D-Q2's CODE mapping is untouched — only the label moves.
--
--   R2   C2 display order becomes F4, F1, F2, F5 (V8, explicit), with the two
--        unproduced codes appended: F3=5, F6=6. Appended rather than
--        interleaved, so that the day C2-F3 is produced its slot is a decision
--        someone takes, not one inherited from a superseded document.
--
--   R3   C3-F9 "Symétrie des attentions & expérience collaborateur" is
--        registered at position 9, status 'undecided', objective and targets
--        NULL. V8 confirms the code and the title and says nothing else; the
--        registry has no 'confirmed' status and inventing prose for a formation
--        nobody has written would be worse than leaving the column empty.
--
--   R4a  C1-F4 "Donnez envie à vos clients de revenir" is registered at
--        position 1, shifting F1->2, F2->3, F3->4.
--
-- ── WHAT A VISITOR SEES THE MOMENT THIS COMMITS ────────────────────────────
--
--   Fondations     C1-F1, C1-F2, C1-F3        UNCHANGED
--   Intermédiaire  C2-F4, C2-F1, C2-F2, C2-F5 CHANGED (was F1, F2, F4, F5)
--
-- Fondations does not move, and that is the point of R4b being deferred. C1-F4
-- is registered here but no course carries the code, so 056's view — which is
-- an inner join onto published courses — has no row for it. The catalogue
-- re-ranks C1-F1/F2/F3 from positions 2,3,4 back to 1,2,3. Section 4 asserts
-- exactly this and refuses to commit on anything else.
--
-- ── WHAT THIS MIGRATION MUST NOT DO (R4b, deferred) ────────────────────────
--
--   * `donnez-envie-a-vos-clients-de-revenir` is NOT assigned C1-F4, and its
--     `courses` row is not read for anything except proof that it is unchanged.
--     That assignment is IRREVERSIBLE (028's courses_code_immutable permits
--     NULL->code exactly once) and is CAT-ARCH-03, an owner action taken in the
--     Admin form — never a migration.
--   * NO `courses` row is written at all. No publication, no preview flag.
--   * NO entitlement, enrollment, progress or certificate is touched.
--   * NO learning path or membership row is touched (that is CAT-ARCH-04).
--   * NOTHING in WC-2: section 5 re-asserts that the browser roles still hold
--     no privilege on a raw lesson media column, as 055 left them.
--   * The publication manifest is NOT part of this migration (R4c, separate PR).
--
-- ── WHY THE INSERTS ARE PERMANENT ──────────────────────────────────────────
--
-- 028's `course_codes_permanent` trigger refuses DELETE on this table outright:
-- retirement is the only exit, so a registered code can never be reused. That
-- is the contract that makes a code a stable business identity — and it means
-- the two INSERTs below cannot be undone. The rollback at the foot of this file
-- restores ORDER and the TITLE; it cannot remove C1-F4 or C3-F9, and says so.
-- The titles must therefore be exactly right at insert time.
-- ============================================================================

-- REPEATABLE READ: every assertion below reads ONE snapshot.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT — the world is exactly what R1–R4 were ruled against ═════
do $do$
declare
  v_missing text;
  v_now     text;
  v_n       integer;
begin
  select string_agg(t, ', ') into v_missing
    from unnest(array['public.catalogues', 'public.course_codes', 'public.courses',
                      'public.learning_paths', 'public.learning_path_courses',
                      'public.public_catalogue_courses']) as t
   where to_regclass(t) is null;
  if v_missing is not null then
    raise exception 'CAT-ARCH-02 057 preflight: required object(s) missing: %', v_missing;
  end if;

  -- CAT-ARCH-01 is a hard precondition. Without the deferrable constraint the
  -- repositioning below would trip uniqueness on its own intermediate state.
  if not exists (
    select 1 from pg_constraint
     where conname = 'course_codes_catalogue_position_unique'
       and conrelid = 'public.course_codes'::regclass
       and contype = 'u' and condeferrable and condeferred
  ) then
    raise exception 'CAT-ARCH-02 057 preflight: migration 056 is not applied (the DEFERRABLE position constraint is absent). Apply 056 first.';
  end if;

  -- The registry must still be closed to the browser roles. 057 publishes
  -- nothing new; if the registry were already open this migration would be
  -- changing what the public can see about the roadmap.
  if has_table_privilege('anon', 'public.course_codes', 'SELECT')
     or has_any_column_privilege('anon', 'public.course_codes', 'SELECT') then
    raise exception 'CAT-ARCH-02 057 preflight: anon holds SELECT on course_codes; the registry is not closed';
  end if;

  -- Exactly the 17 codes seeded by 029, at exactly the positions CAT-ARCH-00
  -- audited. Any difference means someone has already edited the registry and
  -- the rulings were taken against a state that no longer exists.
  select string_agg(cc.code || '@' || cc.position, ',' order by cc.code)
    into v_now from public.course_codes cc;
  if v_now is distinct from
     'C1-F1@1,C1-F2@2,C1-F3@3,'
  || 'C2-F1@1,C2-F2@2,C2-F3@3,C2-F4@4,C2-F5@5,C2-F6@6,'
  || 'C3-F1@1,C3-F2@2,C3-F3@3,C3-F4@4,C3-F5@5,C3-F6@6,C3-F7@7,C3-F8@8' then
    raise exception 'CAT-ARCH-02 057 preflight: the registry is not in the audited pre-V8 state. Found [%]', v_now;
  end if;

  -- Refuse to re-apply rather than write twice.
  if exists (select 1 from public.course_codes where code in ('C1-F4', 'C3-F9')) then
    raise exception 'CAT-ARCH-02 057 preflight: C1-F4 and/or C3-F9 are already registered; refusing to re-apply';
  end if;

  -- R1's starting point, asserted so the title is changed FROM the label the
  -- ruling names and not from something else.
  select canonical_title into v_now from public.course_codes where code = 'C1-F3';
  if v_now is distinct from 'Fondamentaux du service client digital' then
    raise exception 'CAT-ARCH-02 057 preflight: C1-F3 canonical_title is [%], expected the V4 label; R1 was ruled against that value', v_now;
  end if;

  -- R4b's starting point. If this course already carried a code, R4b would
  -- have been performed and this migration's C1-F4 insert would change what a
  -- visitor sees — which it is explicitly not allowed to do.
  select count(*) into v_n
    from public.courses
   where slug = 'donnez-envie-a-vos-clients-de-revenir' and code is null;
  if v_n <> 1 then
    raise exception 'CAT-ARCH-02 057 preflight: donnez-envie-a-vos-clients-de-revenir is absent or already coded; R4b is deferred and this migration assumes it has not happened';
  end if;

  -- The catalogues themselves must exist for the FK to land on.
  select count(*) into v_n from public.catalogues where code in ('C1', 'C3');
  if v_n <> 2 then
    raise exception 'CAT-ARCH-02 057 preflight: catalogues C1 and/or C3 are missing';
  end if;
end
$do$;

-- Everything this migration promises not to change, captured before it runs.
create temp table cat_arch_02_before on commit drop as
select
  (select md5(coalesce(string_agg(to_jsonb(c)::text,  '|' order by c.id),  ''))
     from public.courses c)                                                    as courses_md5,
  (select md5(coalesce(string_agg(to_jsonb(m)::text,  '|' order by m.id),  ''))
     from public.modules m)                                                    as modules_md5,
  (select md5(coalesce(string_agg(to_jsonb(le)::text, '|' order by le.id), ''))
     from public.lessons le)                                                   as lessons_md5,
  (select md5(coalesce(string_agg(to_jsonb(p)::text,  '|' order by p.code), ''))
     from public.learning_paths p)                                             as paths_md5,
  (select md5(coalesce(string_agg(to_jsonb(l)::text,  '|' order by l.path_code, l.course_code), ''))
     from public.learning_path_courses l)                                      as membership_md5,
  (select md5(coalesce(string_agg(to_jsonb(cat)::text, '|' order by cat.code), ''))
     from public.catalogues cat)                                               as catalogues_md5,
  -- Learner state. This migration has no business touching any of it, and the
  -- owner's ruling names all four explicitly, so all four are fingerprinted
  -- rather than merely argued about.
  (select md5(coalesce(string_agg(to_jsonb(e)::text,  '|' order by e.id), ''))
     from public.entitlements e)                                               as entitlements_md5,
  (select md5(coalesce(string_agg(to_jsonb(en)::text, '|' order by en.id), ''))
     from public.enrollments en)                                               as enrollments_md5,
  (select md5(coalesce(string_agg(to_jsonb(lp)::text, '|' order by lp.id), ''))
     from public.lesson_progress lp)                                           as progress_md5,
  (select md5(coalesce(string_agg(to_jsonb(ce)::text, '|' order by ce.id), ''))
     from public.certificates ce)                                              as certificates_md5,
  -- The catalogue a visitor sees right now, through 056's projection.
  (select coalesce(string_agg(v.course_code, ',' order by v.catalogue_code, v.position), '')
     from public.public_catalogue_courses v)                                   as visible_order,
  (select count(*) from public.course_codes)                                   as n_codes,
  -- R4b's subject, fingerprinted on its own so the proof is unambiguous.
  (select md5(coalesce(to_jsonb(c)::text, ''))
     from public.courses c where c.slug = 'donnez-envie-a-vos-clients-de-revenir') as eighth_course_md5;


-- ══ 1. R1 — C1-F3 takes the name the platform has always shown ════════════
--
-- The code is the identity and does not move. This is a label.
update public.course_codes
   set canonical_title = 'Communiquer avec les clients sur les canaux digitaux',
       updated_at      = now()
 where code = 'C1-F3';


-- ══ 2. R3 / R4a — the two codes V8 confirms ═══════════════════════════════
--
-- objective and targets are left NULL deliberately: V8 confirms the code and
-- the title, and states nothing else about either formation. `status` is
-- 'undecided' because that is what the registry means by "registered, launch
-- cohort not yet decided" (D-Q1 is still open) — 'backlog' would claim V8 put
-- them outside launch scope, which it does not say.
insert into public.course_codes
  (code, catalogue_code, canonical_title, objective, targets, position, status) values
  ('C1-F4', 'C1', 'Donnez envie à vos clients de revenir',            null, null, 1, 'undecided'),
  ('C3-F9', 'C3', 'Symétrie des attentions & expérience collaborateur', null, null, 9, 'undecided');


-- ══ 3. R4a / R2 — the display order V8 requires ═══════════════════════════
--
-- Both statements pass through states where a position is duplicated. That is
-- legal here and nowhere else: 056's constraint is DEFERRABLE INITIALLY
-- DEFERRED, so uniqueness is checked once, at COMMIT, over the finished order.
-- This is the whole reason CAT-ARCH-01 shipped before CAT-ARCH-02.

-- C1 — C1-F4 first (V8), the three produced formations behind it.
update public.course_codes
   set position   = v.position,
       updated_at = now()
  from (values ('C1-F1', 2), ('C1-F2', 3), ('C1-F3', 4)) as v(code, position)
 where public.course_codes.code = v.code;

-- C2 — F4, F1, F2, F5 (V8), then the two unproduced codes.
update public.course_codes
   set position   = v.position,
       updated_at = now()
  from (values ('C2-F4', 1), ('C2-F1', 2), ('C2-F2', 3),
               ('C2-F5', 4), ('C2-F3', 5), ('C2-F6', 6)) as v(code, position)
 where public.course_codes.code = v.code;


-- ══ 4. THE REGISTRY IS EXACTLY WHAT THE RULINGS SAY ═══════════════════════
do $do$
declare
  b     record;
  v_now text;
  v_n   integer;
  r     record;
begin
  select * into b from cat_arch_02_before;

  -- 19 codes: the 17 audited plus exactly the two V8 confirms.
  select count(*) into v_n from public.course_codes;
  if v_n <> 19 or b.n_codes <> 17 then
    raise exception 'CAT-ARCH-02 057: registry has % code(s), expected 19 (was %)', v_n, b.n_codes;
  end if;

  -- Every code, at exactly the ruled position. One string, so a single
  -- unexpected row anywhere aborts with the whole picture in the message.
  select string_agg(cc.code || '@' || cc.position, ',' order by cc.code)
    into v_now from public.course_codes cc;
  if v_now is distinct from
     'C1-F1@2,C1-F2@3,C1-F3@4,C1-F4@1,'
  || 'C2-F1@2,C2-F2@3,C2-F3@5,C2-F4@1,C2-F5@4,C2-F6@6,'
  || 'C3-F1@1,C3-F2@2,C3-F3@3,C3-F4@4,C3-F5@5,C3-F6@6,C3-F7@7,C3-F8@8,C3-F9@9' then
    raise exception 'CAT-ARCH-02 057: registry positions are [%], not the R1-R4 ruling', v_now;
  end if;

  -- Contiguous 1..N inside each catalogue, so the admin surface and any future
  -- reorder start from a clean sequence.
  for r in select catalogue_code, count(*) as n, min(position) as lo,
                  max(position) as hi, count(distinct position) as distinct_n
             from public.course_codes group by catalogue_code loop
    if r.lo <> 1 or r.hi <> r.n or r.distinct_n <> r.n then
      raise exception 'CAT-ARCH-02 057: catalogue % is not 1..% (min %, max %, distinct %)',
        r.catalogue_code, r.n, r.lo, r.hi, r.distinct_n;
    end if;
  end loop;

  -- R1 landed, and landed on the right row.
  select canonical_title into v_now from public.course_codes where code = 'C1-F3';
  if v_now is distinct from 'Communiquer avec les clients sur les canaux digitaux' then
    raise exception 'CAT-ARCH-02 057: C1-F3 canonical_title is [%], expected the V8 LMS name', v_now;
  end if;

  -- R3 / R4a landed exactly as ruled, including the empty columns.
  for r in select code, catalogue_code, canonical_title, objective, targets, status
             from public.course_codes where code in ('C1-F4', 'C3-F9') loop
    if r.objective is not null or r.targets is not null then
      raise exception 'CAT-ARCH-02 057: % carries invented objective/targets prose', r.code;
    end if;
    if r.status <> 'undecided' then
      raise exception 'CAT-ARCH-02 057: % has status %, expected undecided', r.code, r.status;
    end if;
  end loop;
  if (select canonical_title from public.course_codes where code = 'C1-F4')
     is distinct from 'Donnez envie à vos clients de revenir' then
    raise exception 'CAT-ARCH-02 057: C1-F4 canonical_title is not the V8 title';
  end if;
  if (select canonical_title from public.course_codes where code = 'C3-F9')
     is distinct from 'Symétrie des attentions & expérience collaborateur' then
    raise exception 'CAT-ARCH-02 057: C3-F9 canonical_title is not the V8 title';
  end if;
  if (select catalogue_code from public.course_codes where code = 'C1-F4') <> 'C1'
     or (select catalogue_code from public.course_codes where code = 'C3-F9') <> 'C3' then
    raise exception 'CAT-ARCH-02 057: a new code landed in the wrong catalogue';
  end if;

  -- No code was renamed away or retired in passing. 028's trigger already
  -- refuses both; this proves the migration did not try.
  select count(*) into v_n from public.course_codes where status = 'retired';
  if v_n <> 0 then
    raise exception 'CAT-ARCH-02 057: % code(s) were retired; this migration retires nothing', v_n;
  end if;
  select count(*) into v_n from public.course_codes where status = 'backlog';
  if v_n <> 1 or not exists (select 1 from public.course_codes where code = 'C2-F6' and status = 'backlog') then
    raise exception 'CAT-ARCH-02 057: backlog status moved; C2-F6 must remain the only backlog code';
  end if;
  select count(*) into v_n from public.course_codes where status = 'launch';
  if v_n <> 0 then
    raise exception 'CAT-ARCH-02 057: a launch status was invented while D-Q1 is still open';
  end if;

  raise notice 'CAT-ARCH-02 057: registry = 19 codes at the R1-R4 positions; C1-F3 renamed; C1-F4 and C3-F9 registered with no invented prose';
end
$do$;


-- ══ 5. THE ORDER THE LEARNER SEES ═════════════════════════════════════════
do $do$
declare
  b      record;
  v_now  text;
  v_n    integer;
  r      record;
begin
  select * into b from cat_arch_02_before;

  -- The visible catalogue, read back through 056's public projection — the
  -- same relation the application reads, not a re-derivation of it.
  select coalesce(string_agg(v.course_code, ',' order by v.catalogue_code, v.position), '')
    into v_now from public.public_catalogue_courses v;

  if b.visible_order is distinct from 'C1-F1,C1-F2,C1-F3,C2-F1,C2-F2,C2-F4,C2-F5' then
    raise exception 'CAT-ARCH-02 057: the catalogue did not start from the audited order. Found [%]', b.visible_order;
  end if;
  if v_now is distinct from 'C1-F1,C1-F2,C1-F3,C2-F4,C2-F1,C2-F2,C2-F5' then
    raise exception 'CAT-ARCH-02 057: the catalogue would become [%], expected C1-F1,C1-F2,C1-F3,C2-F4,C2-F1,C2-F2,C2-F5 (Fondations unchanged until R4b; Intermédiaire led by C2-F4)', v_now;
  end if;

  -- Fondations must not move: R4b is deferred, so C1-F4 has no course and
  -- cannot appear. Asserted directly rather than inferred from the string.
  if exists (select 1 from public.public_catalogue_courses where course_code = 'C1-F4') then
    raise exception 'CAT-ARCH-02 057: C1-F4 entered the public catalogue — R4b is deferred and no course may carry that code yet';
  end if;
  if exists (select 1 from public.public_catalogue_courses where course_code = 'C3-F9') then
    raise exception 'CAT-ARCH-02 057: C3-F9 entered the public catalogue';
  end if;

  -- Still published-only, still re-ranked with no gap, still no unproduced code.
  select count(*) into v_n from public.public_catalogue_courses;
  if v_n <> 7 then
    raise exception 'CAT-ARCH-02 057: the projection has % row(s), expected 7 published coded course(s)', v_n;
  end if;
  select count(*) into v_n
    from public.public_catalogue_courses p
   where not exists (select 1 from public.courses c
                      where c.code = p.course_code and c.is_published = true);
  if v_n <> 0 then
    raise exception 'CAT-ARCH-02 057: % unproduced or unpublished code(s) leaked into the projection', v_n;
  end if;
  for r in select catalogue_code, count(*) as n, min(position) as lo,
                  max(position) as hi, count(distinct position) as distinct_n
             from public.public_catalogue_courses group by catalogue_code loop
    if r.lo <> 1 or r.hi <> r.n or r.distinct_n <> r.n then
      raise exception 'CAT-ARCH-02 057: projected catalogue % is not re-ranked 1..%', r.catalogue_code, r.n;
    end if;
  end loop;

  raise notice 'CAT-ARCH-02 057: visible catalogue [%] — Fondations unchanged, Intermédiaire now led by C2-F4', v_now;
end
$do$;


-- ══ 6. NOTHING ELSE WAS WRITTEN ═══════════════════════════════════════════
do $do$
declare
  b     record;
  v_now text;
  v_n   integer;
  v_role text;
begin
  select * into b from cat_arch_02_before;

  select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) into v_now
    from public.courses c;
  if v_now is distinct from b.courses_md5 then
    raise exception 'CAT-ARCH-02 057: courses changed — this migration writes no course row, no publication flag and no code assignment';
  end if;

  -- R4b, proved on its own row: the eighth course is byte-identical and still
  -- carries no code. The C1-F4 registry entry exists; nothing claims it.
  select md5(coalesce(to_jsonb(c)::text, '')) into v_now
    from public.courses c where c.slug = 'donnez-envie-a-vos-clients-de-revenir';
  if v_now is distinct from b.eighth_course_md5 then
    raise exception 'CAT-ARCH-02 057: the eighth course row changed — R4b is deferred and this migration must not touch it';
  end if;
  select count(*) into v_n from public.courses
   where slug = 'donnez-envie-a-vos-clients-de-revenir' and code is null;
  if v_n <> 1 then
    raise exception 'CAT-ARCH-02 057: the eighth course was assigned a code — R4b belongs to CAT-ARCH-03, in the Admin form, not here';
  end if;

  select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by m.id), '')) into v_now
    from public.modules m;
  if v_now is distinct from b.modules_md5 then
    raise exception 'CAT-ARCH-02 057: modules changed';
  end if;

  select md5(coalesce(string_agg(to_jsonb(le)::text, '|' order by le.id), '')) into v_now
    from public.lessons le;
  if v_now is distinct from b.lessons_md5 then
    raise exception 'CAT-ARCH-02 057: lessons changed — no lesson, and no preview flag, belongs to this slice';
  end if;

  select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.code), '')) into v_now
    from public.learning_paths p;
  if v_now is distinct from b.paths_md5 then
    raise exception 'CAT-ARCH-02 057: learning_paths changed — path work is CAT-ARCH-04';
  end if;

  select md5(coalesce(string_agg(to_jsonb(l)::text, '|' order by l.path_code, l.course_code), '')) into v_now
    from public.learning_path_courses l;
  if v_now is distinct from b.membership_md5 then
    raise exception 'CAT-ARCH-02 057: path membership changed — CAT-ARCH-04 owns that, not this migration';
  end if;

  select md5(coalesce(string_agg(to_jsonb(cat)::text, '|' order by cat.code), '')) into v_now
    from public.catalogues cat;
  if v_now is distinct from b.catalogues_md5 then
    raise exception 'CAT-ARCH-02 057: catalogues changed';
  end if;

  -- Learner state: a display-order migration must not have moved a single row
  -- of it. Checked, not assumed.
  select md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by e.id), '')) into v_now
    from public.entitlements e;
  if v_now is distinct from b.entitlements_md5 then
    raise exception 'CAT-ARCH-02 057: entitlements changed — entitlement remains the access authority and this slice does not touch it';
  end if;
  select md5(coalesce(string_agg(to_jsonb(en)::text, '|' order by en.id), '')) into v_now
    from public.enrollments en;
  if v_now is distinct from b.enrollments_md5 then
    raise exception 'CAT-ARCH-02 057: enrollments changed';
  end if;
  select md5(coalesce(string_agg(to_jsonb(lp)::text, '|' order by lp.id), '')) into v_now
    from public.lesson_progress lp;
  if v_now is distinct from b.progress_md5 then
    raise exception 'CAT-ARCH-02 057: lesson_progress changed — learner progress is untouchable here';
  end if;
  select md5(coalesce(string_agg(to_jsonb(ce)::text, '|' order by ce.id), '')) into v_now
    from public.certificates ce;
  if v_now is distinct from b.certificates_md5 then
    raise exception 'CAT-ARCH-02 057: certificates changed';
  end if;

  -- The boundaries this slice must not have moved. A data migration that
  -- quietly re-opened a grant would be a poor trade for a display order.
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_table_privilege(v_role, 'public.course_codes', 'SELECT')
       or has_any_column_privilege(v_role, 'public.course_codes', 'SELECT') then
      raise exception 'CAT-ARCH-02 057: % can read course_codes — the registry must stay closed', v_role;
    end if;
    if has_table_privilege(v_role, 'public.catalogues', 'SELECT')
       or has_any_column_privilege(v_role, 'public.catalogues', 'SELECT') then
      raise exception 'CAT-ARCH-02 057: % can read catalogues — the registry must stay closed', v_role;
    end if;
    if not has_table_privilege(v_role, 'public.public_catalogue_courses', 'SELECT') then
      raise exception 'CAT-ARCH-02 057: % lost SELECT on the public projection', v_role;
    end if;
    -- WC-2C (055) is a precondition of this slice, not a casualty of it.
    if has_column_privilege(v_role, 'public.lessons', 'video_object_path', 'SELECT')
       or has_column_privilege(v_role, 'public.lessons', 'pdf_object_path', 'SELECT')
       or has_column_privilege(v_role, 'public.lessons', 'subtitle_object_path', 'SELECT') then
      raise exception 'CAT-ARCH-02 057: % regained SELECT on a raw lesson media column — WC-2 must stay closed', v_role;
    end if;
  end loop;

  raise notice 'CAT-ARCH-02 057: courses, modules, lessons, paths, membership, catalogues, entitlements, enrollments, progress and certificates are byte-identical; the eighth course is untouched and still uncoded; the registry and WC-2 remain closed';
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Apply only after the owner authorises it. Migration 056 must already be
--    applied (section 0 refuses otherwise), and the CAT-ARCH-01 application
--    release must be live — it is: the deployed reader orders by the view's
--    position, so the new order takes effect with no deploy of any kind.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once. The
--    editor will warn about the temporary snapshot table; choose "Run without
--    RLS", as for 054 and 056. "Success" means every assertion passed: the file
--    is one transaction and any failure raises and rolls everything back.
--
--    This migration takes a brief row lock on 8 registry rows and writes no
--    other table. It completes in milliseconds.
-- 3. `/courses` is prerendered with a 60-second revalidate, so Intermédiaire
--    reorders within about a minute. No deploy, no cache purge.
-- 4. Immediately afterwards, GET-only, as the anonymous key:
--      /rest/v1/public_catalogue_courses?select=*  -> 7 rows; C1 = F1,F2,F3 and
--                                                     C2 = F4,F1,F2,F5
--      /rest/v1/course_codes?select=code           -> 401 with code 42501
--    and confirm Fondations is unchanged on /courses.
-- 5. Still deferred after this migration: R4b (assign C1-F4 to
--    `donnez-envie-a-vos-clients-de-revenir`, CAT-ARCH-03, owner action in the
--    Admin form) and R4c (publication manifest, separate PR).
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — PARTIAL BY DESIGN. Read this before applying.
-- ════════════════════════════════════════════════════════════════════════════
--
-- 028's `course_codes_permanent` trigger refuses DELETE on this table, so
-- C1-F4 and C3-F9 CANNOT be removed once this migration commits. That is the
-- contract that makes a code permanent, and it is deliberate.
--
-- What the block below restores: the display order and C1-F3's title — i.e.
-- everything a learner or an admin can see. C1-F4 is parked at the end of C1
-- and C3-F9 stays at 9; both are invisible to visitors because no course
-- carries them. Their status is left 'undecided' rather than 'retired':
-- retirement means "never reuse", which is not what a rollback intends.
--
-- Run it WHOLE. It touches no course, no lesson and no grant.
--
-- begin;
--
-- update public.course_codes
--    set position = v.position, updated_at = now()
--   from (values ('C1-F1', 1), ('C1-F2', 2), ('C1-F3', 3), ('C1-F4', 4),
--                ('C2-F1', 1), ('C2-F2', 2), ('C2-F3', 3),
--                ('C2-F4', 4), ('C2-F5', 5), ('C2-F6', 6)) as v(code, position)
--  where public.course_codes.code = v.code;
--
-- update public.course_codes
--    set canonical_title = 'Fondamentaux du service client digital', updated_at = now()
--  where code = 'C1-F3';
--
-- do $rb$
-- declare v_now text;
-- begin
--   select coalesce(string_agg(v.course_code, ',' order by v.catalogue_code, v.position), '')
--     into v_now from public.public_catalogue_courses v;
--   if v_now is distinct from 'C1-F1,C1-F2,C1-F3,C2-F1,C2-F2,C2-F4,C2-F5' then
--     raise exception 'CAT-ARCH-02 057 rollback: the catalogue is [%], not the pre-V8 order', v_now;
--   end if;
--   if not exists (select 1 from public.course_codes where code = 'C1-F4' and position = 4) then
--     raise exception 'CAT-ARCH-02 057 rollback: C1-F4 was not parked at the end of C1';
--   end if;
-- end
-- $rb$;
--
-- commit;
