import { notFound } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { CheckCircle, Clock, BookOpen, Users, Award, Play, Lock, ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { formatPrice, LEVEL_LABELS } from '@/lib/utils/cn'
import { FLAGSHIP_COURSE, COURSE_MODULES, COURSE_COPY } from '@/data/seed'
import { FREE_ACCESS_MODE, PILOT_MODE } from '@/lib/pilot'
import type { Metadata } from 'next'

const COURSE_META: Record<string, { number: number; objectives: string[]; image: string }> = {
  'fondamentaux-experience-client': {
    number: 1,
    objectives: [
      "Comprendre les fondamentaux de l'expérience client",
      'Analyser le parcours client de bout en bout',
      'Identifier les moments clés de la relation client',
      'Appliquer les principes CX dans votre contexte',
    ],
    image: '/images/Formation1.jpg',
  },
  'comprendre-client-qualite-experience': {
    number: 1,
    objectives: [
      "Comprendre les fondamentaux de l'expérience client",
      'Analyser le parcours client de bout en bout',
      'Identifier les moments clés de la relation client',
      'Fidéliser vos clients grâce à la qualité de service',
    ],
    image: '/images/Formation1.jpg',
  },
  'excellence-dans-le-service-client': {
    number: 1,
    objectives: [
      "Comprendre les fondamentaux de l'expérience client",
      'Analyser le parcours et les attentes des clients',
      'Créer des interactions mémorables et de qualité',
      'Gérer efficacement les situations difficiles',
      'Mesurer et améliorer la satisfaction client',
      'Fidéliser vos clients sur le long terme',
    ],
    image: '/images/Formation1.jpg',
  },
  'experience-client-memorable': {
    number: 2,
    objectives: ['Concevoir des interactions mémorables', 'Fidéliser vos clients'],
    image: '/images/Formation1.jpg',
  },
  'service-client-digital': {
    number: 3,
    objectives: ['Maîtriser les canaux digitaux', 'Utiliser les outils CRM'],
    image: '/images/Formation1.jpg',
  },
}

interface Props { params: Promise<{ slug: string }> }

function normalizeSlug(raw: string): string {
  return decodeURIComponent(raw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug: rawSlug } = await params
  const slug = normalizeSlug(rawSlug)
  const supabase = await createClient()

  const { data: course } = await supabase
    .from('courses')
    .select('title, description, cover_url')
    .eq('slug', slug)
    .eq('is_published', true)
    .maybeSingle()

  const title       = course?.title       ?? (slug === FLAGSHIP_COURSE.slug ? FLAGSHIP_COURSE.title       : slug.replace(/-/g, ' '))
  const description = course?.description ?? (slug === FLAGSHIP_COURSE.slug ? FLAGSHIP_COURSE.description : undefined)
  const image       = course?.cover_url   ?? null

  return {
    title,
    description: description ?? undefined,
    openGraph: {
      title,
      description: description ?? undefined,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card:  image ? 'summary_large_image' : 'summary',
      title,
      description: description ?? undefined,
    },
  }
}

export default async function CourseDetailPage({ params }: Props) {
  const { slug: rawSlug } = await params
  const slug = normalizeSlug(rawSlug)
  const supabase = await createClient()

  let modules = COURSE_MODULES

  // Look up course first, without any join — avoids silent failures from join RLS
  const { data: dbCourse } = await supabase
    .from('courses')
    .select('*')
    .eq('slug', slug)
    .eq('is_published', true)
    .maybeSingle()

  if (!dbCourse && slug !== FLAGSHIP_COURSE.slug) notFound()

  // Load modules + lessons separately so a join issue never hides the course
  if (dbCourse) {
    const { data: dbModules } = await supabase
      .from('modules')
      .select('*, lessons(*)')
      .eq('course_id', dbCourse.id)
      .order('order_index')

    modules = (dbModules ?? []).map((m: any) => ({
      ...m,
      lessons: [...(m.lessons ?? [])].sort((a: any, b: any) => a.order_index - b.order_index),
    }))
  }

  const { data: { user } } = await supabase.auth.getUser()
  let isEnrolled = false
  if (user) {
    const { data: enroll } = await supabase
      .from('enrollments')
      .select('id')
      .eq('user_id', user.id)
      .eq('course_id', dbCourse?.id ?? 'seed')
      .single()
    isEnrolled = !!enroll
  }

  const totalLessons   = modules.reduce((n: number, m: typeof COURSE_MODULES[number]) => n + m.lessons.length, 0)
  const price          = dbCourse?.price          ?? FLAGSHIP_COURSE.price
  const currency       = dbCourse?.currency       ?? FLAGSHIP_COURSE.currency
  const title          = dbCourse?.title          ?? FLAGSHIP_COURSE.title
  const description    = dbCourse?.description    ?? FLAGSHIP_COURSE.description
  const level          = dbCourse?.level          ?? FLAGSHIP_COURSE.level
  const durationHours  = dbCourse?.duration_hours ?? FLAGSHIP_COURSE.duration_hours
  const meta           = COURSE_META[slug]
  const coverImage     = dbCourse?.cover_url      ?? meta?.image ?? null
  const introVideoUrl  = (dbCourse as Record<string, unknown> | null)?.intro_video_url as string | null ?? null

  const learnHref = PILOT_MODE
    ? `/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`
    : user
      ? `/checkout?course=${dbCourse?.id ?? slug}`
      : `/login?next=/checkout?course=${dbCourse?.id ?? slug}`

  return (
    <div>

      {/* ══ Hero ═══════════════════════════════════════════════════════ */}
      <section className="bg-light border-b border-black/[0.06] py-10 md:py-14">
        <div className="cx-container">
          <div className="grid lg:grid-cols-[1fr_420px] gap-10 items-start">

            {/* Left: info + CTAs */}
            <div className="flex flex-col gap-5">

              {/* Badges */}
              <div className="flex flex-wrap gap-2">
                {meta && (
                  <span className="bg-secondary/10 text-secondary text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wide">
                    Formation {meta.number}
                  </span>
                )}
                <span className="bg-primary/10 text-primary text-xs font-semibold px-3 py-1 rounded-full">
                  {LEVEL_LABELS[level]}
                </span>
                {(PILOT_MODE || FREE_ACCESS_MODE) && (
                  <span className="bg-green-100 text-green-700 text-xs font-bold px-3 py-1 rounded-full">
                    Accès gratuit
                  </span>
                )}
              </div>

              {/* Title + description */}
              <div className="space-y-3">
                <h1 className="text-2xl md:text-3xl font-extrabold text-dark leading-tight">
                  {title}
                </h1>
                <p className="text-cx-gray leading-relaxed max-w-prose">{description}</p>
              </div>

              {/* Stats */}
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-cx-gray">
                <span className="flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-primary/70 shrink-0" />
                  {durationHours}h de contenu
                </span>
                <span className="flex items-center gap-1.5">
                  <BookOpen className="w-4 h-4 text-primary/70 shrink-0" />
                  {modules.length} modules
                </span>
                <span className="flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-primary/70 shrink-0" />
                  {totalLessons} leçons
                </span>
                <span className="flex items-center gap-1.5">
                  <Award className="w-4 h-4 text-primary/70 shrink-0" />
                  Certificat inclus
                </span>
              </div>

              {/* CTAs */}
              <div className="flex flex-col sm:flex-row gap-3 pt-1">
                {isEnrolled && !PILOT_MODE ? (
                  <Link
                    href={`/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`}
                    className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-success text-white font-bold rounded-cx hover:opacity-90 transition-opacity text-sm"
                  >
                    <Play className="w-4 h-4" /> Continuer la formation
                  </Link>
                ) : (
                  <Link
                    href={learnHref}
                    className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5 shadow-btn text-sm"
                  >
                    <Play className="w-4 h-4" />
                    {PILOT_MODE || FREE_ACCESS_MODE ? 'Commencer gratuitement' : COURSE_COPY.enrollment_cta}
                  </Link>
                )}
                <a
                  href="#curriculum"
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 border-2 border-primary/20 text-primary font-semibold rounded-cx hover:bg-primary/5 transition-colors text-sm"
                >
                  Voir le programme
                </a>
              </div>

              {/* Access note */}
              {PILOT_MODE && (
                <p className="text-xs text-cx-gray flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                  Accès libre · Phase pilote · Aucun compte requis
                </p>
              )}
              {FREE_ACCESS_MODE && !PILOT_MODE && (
                <p className="text-xs text-cx-gray flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                  Accès gratuit · Certificat inclus · Phase pilote
                </p>
              )}
              {!PILOT_MODE && !FREE_ACCESS_MODE && !user && (
                <p className="text-xs text-cx-gray">
                  <Link href="/login" className="text-primary hover:underline">Connexion</Link> requise avant l&apos;achat
                </p>
              )}
            </div>

            {/* Right: video + included card */}
            <div className="flex flex-col gap-4">

              {/* Video / cover */}
              <div className="aspect-video overflow-hidden rounded-3xl shadow-lg bg-black">
                {introVideoUrl ? (
                  <video
                    controls
                    preload="metadata"
                    className="w-full h-full object-contain bg-black"
                    poster={coverImage ?? undefined}
                  >
                    <source src={introVideoUrl} type="video/mp4" />
                    Your browser does not support the video tag.
                  </video>
                ) : coverImage ? (
                  <div className="relative w-full h-full">
                    <Image src={coverImage} alt={title} fill className="object-cover" priority />
                  </div>
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-primary/10 to-secondary/10 flex items-center justify-center">
                    <BookOpen className="w-16 h-16 text-primary/30" />
                  </div>
                )}
              </div>

              {/* What's included */}
              <div className="bg-white rounded-2xl border border-black/[0.07] p-4">
                <p className="text-xs font-bold text-cx-gray uppercase tracking-wide mb-3">Ce qui est inclus</p>
                <div className="grid grid-cols-2 gap-y-2 gap-x-2">
                  {[
                    `${modules.length} modules complets`,
                    `${totalLessons} leçons`,
                    'Quiz par module',
                    'Certificat de réussite',
                    'Accès mobile & desktop',
                    'Accès à vie',
                  ].map(item => (
                    <div key={item} className="flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                      <span className="text-xs text-cx-gray">{item}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-3 pt-3 border-t border-black/[0.06]">
                  {FREE_ACCESS_MODE || PILOT_MODE ? (
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-extrabold text-dark">Gratuit</span>
                      <span className="text-xs text-cx-gray">— phase pilote</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2 mb-2">
                        <span className="text-lg font-extrabold text-dark">{formatPrice(price, currency)}</span>
                        <span className="text-xs text-cx-gray">Accès complet à vie</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {['🟠 Orange Money', '🔵 Wave', '💳 Carte'].map(m => (
                          <span key={m} className="text-xs px-2 py-0.5 bg-light rounded-full text-cx-gray">{m}</span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

            </div>
          </div>
        </div>
      </section>

      {/* ══ Learning outcomes ══════════════════════════════════════════ */}
      {meta?.objectives && meta.objectives.length > 0 && (
        <section className="bg-white border-b border-black/[0.06] py-10">
          <div className="cx-container max-w-4xl">
            <h2 className="text-xl font-extrabold text-dark mb-6">Ce que vous allez apprendre</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {meta.objectives.map(obj => (
                <div key={obj} className="flex items-start gap-3 p-3.5 rounded-xl border border-black/[0.05] bg-light/60">
                  <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
                  <span className="text-sm text-dark leading-snug">{obj}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ══ Curriculum ═════════════════════════════════════════════════ */}
      <section id="curriculum" className="cx-section">
        <div className="cx-container max-w-3xl">
          <h2 className="text-xl font-extrabold text-dark mb-6">Programme de la formation</h2>

          <div className="flex flex-col gap-3">
            {modules.map((mod: typeof COURSE_MODULES[number], i: number) => (
              <details key={mod.slug} className="cx-card overflow-hidden group" open={i === 0}>
                <summary className="flex items-center justify-between p-4 sm:p-5 cursor-pointer list-none hover:bg-light/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold shrink-0">
                      {i + 1}
                    </span>
                    <div>
                      <p className="font-semibold text-dark text-sm">{mod.title}</p>
                      <p className="text-xs text-cx-gray mt-0.5">
                        {mod.lessons.length} leçon{mod.lessons.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <ChevronDown className="w-4 h-4 text-cx-gray group-open:rotate-180 transition-transform shrink-0" />
                </summary>

                <div className="border-t border-black/[0.06] divide-y divide-black/[0.03]">
                  {mod.lessons.map((lesson: typeof COURSE_MODULES[number]['lessons'][number]) => (
                    <div key={lesson.slug} className="flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-light/30 transition-colors">
                      {(lesson.is_preview || FREE_ACCESS_MODE) ? (
                        <Play className="w-3.5 h-3.5 text-primary shrink-0" />
                      ) : (
                        <Lock className="w-3.5 h-3.5 text-cx-gray/50 shrink-0" />
                      )}
                      <span className="text-sm text-dark flex-1 leading-snug">{lesson.title}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {lesson.duration_minutes && (
                          <span className="text-xs text-cx-gray">{lesson.duration_minutes} min</span>
                        )}
                        {(lesson.is_preview || FREE_ACCESS_MODE) && (
                          <span className="text-[10px] font-bold text-success bg-green-50 px-2 py-0.5 rounded-full">
                            GRATUIT
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>

          {/* Bottom CTA */}
          <div className="mt-10 bg-light rounded-2xl p-8 text-center border border-black/[0.05]">
            <p className="text-sm text-cx-gray mb-5">
              {PILOT_MODE
                ? 'Accès libre · Phase pilote · Aucun compte requis'
                : FREE_ACCESS_MODE
                ? 'Accès gratuit · Certificat inclus · Phase pilote'
                : 'Accès immédiat après paiement · Orange Money · Wave · Carte'}
            </p>
            <Link
              href={
                PILOT_MODE
                  ? `/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`
                  : user
                    ? `/checkout?course=${dbCourse?.id ?? slug}`
                    : `/login?next=/checkout?course=${dbCourse?.id ?? slug}`
              }
              className="inline-flex items-center gap-2 px-10 py-4 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5 shadow-btn text-base"
            >
              <Play className="w-5 h-5" />
              {PILOT_MODE
                ? 'Commencer maintenant'
                : FREE_ACCESS_MODE
                ? 'Commencer gratuitement'
                : COURSE_COPY.payment_cta}
            </Link>
            {!PILOT_MODE && !FREE_ACCESS_MODE && !user && (
              <p className="text-xs text-cx-gray mt-4">
                <Link href={`/login?next=/checkout?course=${dbCourse?.id ?? slug}`} className="text-primary hover:underline">Connectez-vous</Link>
                {' '}ou{' '}
                <Link href={`/signup?next=/checkout?course=${dbCourse?.id ?? slug}`} className="text-primary hover:underline">créez un compte</Link>
                {' '}pour accéder
              </p>
            )}
          </div>
        </div>
      </section>

    </div>
  )
}
