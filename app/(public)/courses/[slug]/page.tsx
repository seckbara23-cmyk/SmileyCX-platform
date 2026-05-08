import { notFound } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { CheckCircle, Clock, BookOpen, Users, Award, Play, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { formatPrice, LEVEL_LABELS } from '@/lib/utils/cn'
import { FLAGSHIP_COURSE, COURSE_MODULES, COURSE_COPY } from '@/data/seed'
import { FREE_ACCESS_MODE, PILOT_MODE } from '@/lib/pilot'
import type { Metadata } from 'next'

const COURSE_META: Record<string, { number: number; objectives: string[]; image: string }> = {
  'fondamentaux-experience-client': {
    number: 1,
    objectives: ["Comprendre l'expérience client", 'Comprendre le parcours client'],
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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
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
  const { slug } = await params
  const supabase = await createClient()

  // Try to load from DB; fall back to seed data
  let course = null
  let modules = COURSE_MODULES

  const { data: dbCourse } = await supabase
    .from('courses')
    .select('*, modules(*, lessons(*))')
    .eq('slug', slug)
    .eq('is_published', true)
    .single()

  if (dbCourse) {
    course = dbCourse
    modules = (dbCourse.modules ?? []).sort((a: any, b: any) => a.order_index - b.order_index)
      .map((m: any) => ({ ...m, lessons: [...(m.lessons ?? [])].sort((a: any, b: any) => a.order_index - b.order_index) }))
  } else if (slug !== FLAGSHIP_COURSE.slug) {
    notFound()
  }

  // Check enrollment
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

  const totalLessons = modules.reduce((n: number, m: typeof COURSE_MODULES[number]) => n + m.lessons.length, 0)
  const price = dbCourse?.price ?? FLAGSHIP_COURSE.price
  const currency = dbCourse?.currency ?? FLAGSHIP_COURSE.currency
  const title = dbCourse?.title ?? FLAGSHIP_COURSE.title
  const description = dbCourse?.description ?? FLAGSHIP_COURSE.description
  const level = dbCourse?.level ?? FLAGSHIP_COURSE.level
  const durationHours = dbCourse?.duration_hours ?? FLAGSHIP_COURSE.duration_hours
  const meta           = COURSE_META[slug]
  const coverImage     = dbCourse?.cover_url ?? meta?.image ?? null
  const introVideoUrl  = (dbCourse as Record<string, unknown> | null)?.intro_video_url as string | null ?? null

  const learnHref = PILOT_MODE
    ? `/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`
    : user
      ? `/checkout?course=${dbCourse?.id ?? slug}`
      : `/login?next=/checkout?course=${dbCourse?.id ?? slug}`

  return (
    <div>
      {/* ── Course Hero ──────────────────────────────────────────── */}
      <div className="bg-light border-b border-black/[0.06] py-12">
        <div className="cx-container">
          <div className="grid lg:grid-cols-[1fr_400px] gap-10 items-center">

            {/* Left: course info */}
            <div>
              {meta && (
                <span className="inline-block bg-secondary/10 text-secondary text-xs font-bold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
                  Formation {meta.number}
                </span>
              )}
              <span className="inline-block ml-2 bg-primary/10 text-primary text-xs font-semibold px-3 py-1 rounded-full mb-4">
                {LEVEL_LABELS[level]}
              </span>
              <h1 className="text-2xl md:text-3xl font-extrabold text-dark leading-tight mb-4">{title}</h1>
              <p className="text-cx-gray leading-relaxed mb-6">{description}</p>

              {meta?.objectives && (
                <div className="flex flex-col gap-2 mb-6">
                  {meta.objectives.map(obj => (
                    <div key={obj} className="flex items-center gap-2 text-sm text-dark">
                      <CheckCircle className="w-4 h-4 text-success shrink-0" /> {obj}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-5 text-sm text-cx-gray mb-8">
                <span className="flex items-center gap-1.5"><Clock className="w-4 h-4" /> {durationHours}h de contenu</span>
                <span className="flex items-center gap-1.5"><BookOpen className="w-4 h-4" /> {modules.length} modules</span>
                <span className="flex items-center gap-1.5"><Users className="w-4 h-4" /> {totalLessons} leçons</span>
                <span className="flex items-center gap-1.5"><Award className="w-4 h-4" /> Certificat inclus</span>
              </div>

              <Link
                href={learnHref}
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5 shadow-btn"
              >
                <Play className="w-4 h-4" />
                {PILOT_MODE ? 'Voir la formation' : FREE_ACCESS_MODE ? 'Commencer gratuitement' : COURSE_COPY.enrollment_cta}
              </Link>
            </div>

            {/* Right: intro video or cover image */}
            {introVideoUrl ? (
              <div className="rounded-2xl overflow-hidden shadow-md bg-black" style={{ aspectRatio: '16/9' }}>
                <video
                  src={introVideoUrl}
                  controls
                  className="w-full h-full"
                  preload="metadata"
                />
              </div>
            ) : coverImage ? (
              <div className="relative rounded-2xl overflow-hidden aspect-[4/3] shadow-md">
                <Image src={coverImage} alt={title} fill className="object-cover" priority />
              </div>
            ) : (
              <div className="rounded-2xl overflow-hidden aspect-[4/3] bg-gradient-to-br from-primary/10 to-secondary/10 flex items-center justify-center">
                <BookOpen className="w-16 h-16 text-primary/30" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Enrollment card ──────────────────────────────────────── */}
      <div className="bg-white border-b border-black/[0.06] py-8">
        <div className="cx-container">
          <div className="max-w-sm mx-auto cx-card p-6 text-dark">
              {/* TEMP_FREE_ACCESS: Show "Gratuit" instead of price during pilot */}
              <p className="text-3xl font-extrabold mb-1">
                {FREE_ACCESS_MODE ? 'Gratuit' : formatPrice(price, currency)}
              </p>
              <p className="text-sm text-cx-gray mb-5">
                {/* TEMP_FREE_ACCESS: pilot subtitle */}
                {FREE_ACCESS_MODE ? 'Accès gratuit — phase pilote' : 'Accès complet à vie'}
              </p>

              {/* PILOT_MODE: direct link to learning — no login or checkout */}
              {PILOT_MODE ? (
                <Link
                  href={`/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5 shadow-btn"
                >
                  <Play className="w-5 h-5" /> Commencer maintenant
                </Link>
              ) : isEnrolled ? (
                <Link
                  href={`/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-success text-white font-bold rounded-cx hover:opacity-90 transition-opacity"
                >
                  <Play className="w-5 h-5" /> Continuer la formation
                </Link>
              ) : (
                <Link
                  href={
                    user
                      ? `/checkout?course=${dbCourse?.id ?? slug}`
                      : `/login?next=/checkout?course=${dbCourse?.id ?? slug}`
                  }
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5 shadow-btn"
                >
                  {FREE_ACCESS_MODE ? 'Commencer gratuitement' : COURSE_COPY.enrollment_cta}
                </Link>
              )}

              {!PILOT_MODE && !user && (
                <p className="text-xs text-cx-gray text-center mt-3">
                  {FREE_ACCESS_MODE ? (
                    <><Link href={`/login?next=/checkout?course=${dbCourse?.id ?? slug}`} className="text-primary hover:underline">Connectez-vous</Link> ou <Link href={`/signup?next=/checkout?course=${dbCourse?.id ?? slug}`} className="text-primary hover:underline">créez un compte</Link> pour accéder gratuitement</>
                  ) : (
                    <><Link href="/login" className="text-primary hover:underline">Connexion</Link> requise avant l&apos;achat</>
                  )}
                </p>
              )}

              <div className="mt-5 pt-4 border-t border-black/[0.06]">
                <p className="text-xs text-cx-gray font-semibold mb-3">Ce qui est inclus :</p>
                {[
                  `${modules.length} modules complets`,
                  `${totalLessons} leçons`,
                  'Quiz par module',
                  'Certificat de réussite',
                  'Accès mobile & desktop',
                ].map(item => (
                  <div key={item} className="flex items-center gap-2 text-sm py-1">
                    <CheckCircle className="w-4 h-4 text-success shrink-0" />
                    {item}
                  </div>
                ))}
              </div>

              {/* TEMP_FREE_ACCESS: Show pilot badge instead of payment methods */}
              {FREE_ACCESS_MODE ? (
                <div className="mt-4 pt-4 border-t border-black/[0.06]">
                  <p className="text-xs text-success font-semibold">
                    ✅ Accès gratuit pendant la phase pilote
                  </p>
                </div>
              ) : (
                <div className="mt-4 pt-4 border-t border-black/[0.06]">
                  <p className="text-xs text-cx-gray font-semibold mb-2">Paiement accepté :</p>
                  <div className="flex gap-2 flex-wrap">
                    {['🟠 Orange Money', '🔵 Wave', '💳 Carte'].map(m => (
                      <span key={m} className="text-xs px-2.5 py-1 bg-light rounded-full">{m}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

      {/* ── Curriculum ───────────────────────────────────────────── */}
      <div className="cx-section">
        <div className="cx-container max-w-3xl">
          <h2 className="text-2xl font-extrabold text-dark mb-8">Programme de la formation</h2>

          <div className="flex flex-col gap-4">
            {modules.map((mod: typeof COURSE_MODULES[number], i: number) => (
              <details key={mod.slug} className="cx-card overflow-hidden group" open={i === 0}>
                <summary className="flex items-center justify-between p-5 cursor-pointer list-none hover:bg-light/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold shrink-0">
                      {i + 1}
                    </span>
                    <div>
                      <p className="font-semibold text-dark">{mod.title}</p>
                      <p className="text-xs text-cx-gray">{mod.lessons.length} leçons</p>
                    </div>
                  </div>
                  <span className="text-cx-gray text-sm group-open:rotate-180 transition-transform">▼</span>
                </summary>

                <div className="border-t border-black/[0.06]">
                  {mod.lessons.map((lesson: typeof COURSE_MODULES[number]['lessons'][number], j: number) => (
                    <div key={lesson.slug} className="flex items-center gap-3 px-5 py-3 hover:bg-light/30 transition-colors">
                      {/* TEMP_FREE_ACCESS: show Play for all lessons; Lock only when paid */}
                      {(lesson.is_preview || FREE_ACCESS_MODE) ? (
                        <Play className="w-4 h-4 text-primary shrink-0" />
                      ) : (
                        <Lock className="w-4 h-4 text-cx-gray/50 shrink-0" />
                      )}
                      <span className="text-sm text-dark flex-1">{lesson.title}</span>
                      {lesson.duration_minutes && (
                        <span className="text-xs text-cx-gray">{lesson.duration_minutes} min</span>
                      )}
                      {/* TEMP_FREE_ACCESS: show GRATUIT on all lessons during pilot */}
                      {(lesson.is_preview || FREE_ACCESS_MODE) && (
                        <span className="text-[10px] font-bold text-success bg-green-50 px-2 py-0.5 rounded-full">
                          GRATUIT
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>

          {/* Bottom CTA */}
          <div className="mt-10 text-center">
            <Link
              href={
                PILOT_MODE
                  ? `/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`
                  : user
                    ? `/checkout?course=${dbCourse?.id ?? slug}`
                    : `/login?next=/checkout?course=${dbCourse?.id ?? slug}`
              }
              className="inline-flex items-center gap-2 px-10 py-4 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5 shadow-btn text-lg"
            >
              {PILOT_MODE ? 'Commencer maintenant' : FREE_ACCESS_MODE ? 'Commencer gratuitement' : COURSE_COPY.payment_cta}
            </Link>
            <p className="text-xs text-cx-gray mt-3">
              {PILOT_MODE
                ? 'Accès libre · Phase pilote · Aucun compte requis'
                : FREE_ACCESS_MODE
                  ? 'Accès gratuit · Certificat inclus · Phase pilote'
                  : 'Accès immédiat après paiement · Orange Money · Wave · Carte'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
