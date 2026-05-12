import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { MessageSquare, Star, ThumbsUp, ThumbsDown } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Retours pilote' }

interface PageProps {
  searchParams?: { course?: string }
}

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {[1,2,3,4,5].map(i => (
        <Star key={i} className={`w-3.5 h-3.5 ${i <= n ? 'fill-amber-400 text-amber-400' : 'fill-none text-gray-200'}`} />
      ))}
    </span>
  )
}

export default async function AdminFeedbackPage({ searchParams }: PageProps) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()
  const courseFilter = searchParams?.course ?? ''

  const { data: rawRows } = await supabase
    .from('pilot_feedback')
    .select('id, course_id, clarity_rating, practical_value_rating, ease_of_use_rating, most_useful, confusing_part, would_recommend, fair_price, comment, created_at, courses(title, slug), profiles(full_name, email)')
    .order('created_at', { ascending: false })
    .limit(500)

  type FeedbackRow = {
    id: string
    course_id: string
    clarity_rating: number
    practical_value_rating: number
    ease_of_use_rating: number
    most_useful: string | null
    confusing_part: string | null
    would_recommend: boolean | null
    fair_price: string | null
    comment: string | null
    created_at: string
    courses: { title: string; slug: string } | null
    profiles: { full_name: string | null; email: string } | null
  }

  const rows: FeedbackRow[] = ((rawRows ?? []) as unknown[]).map(r => {
    const raw = r as Record<string, unknown>
    return {
      id:                     raw.id as string,
      course_id:              raw.course_id as string,
      clarity_rating:         raw.clarity_rating as number,
      practical_value_rating: raw.practical_value_rating as number,
      ease_of_use_rating:     raw.ease_of_use_rating as number,
      most_useful:            raw.most_useful as string | null,
      confusing_part:         raw.confusing_part as string | null,
      would_recommend:        raw.would_recommend as boolean | null,
      fair_price:             raw.fair_price as string | null,
      comment:                raw.comment as string | null,
      created_at:             raw.created_at as string,
      courses: Array.isArray(raw.courses)
        ? (raw.courses[0] as { title: string; slug: string } ?? null)
        : raw.courses as { title: string; slug: string } | null,
      profiles: Array.isArray(raw.profiles)
        ? (raw.profiles[0] as { full_name: string | null; email: string } ?? null)
        : raw.profiles as { full_name: string | null; email: string } | null,
    }
  })

  const filtered = courseFilter ? rows.filter(r => r.course_id === courseFilter) : rows

  // Aggregate stats
  function avg(arr: number[]) {
    if (!arr.length) return 0
    return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10
  }
  const clarityAvg   = avg(filtered.map(r => r.clarity_rating))
  const practicalAvg = avg(filtered.map(r => r.practical_value_rating))
  const easeAvg      = avg(filtered.map(r => r.ease_of_use_rating))
  const overallAvg   = avg(filtered.flatMap(r => [r.clarity_rating, r.practical_value_rating, r.ease_of_use_rating]))
  const recommendYes = filtered.filter(r => r.would_recommend === true).length
  const recommendNo  = filtered.filter(r => r.would_recommend === false).length

  // Distinct courses for filter
  const courseMap: Record<string, string> = {}
  rows.forEach(r => { if (r.courses) courseMap[r.course_id] = r.courses.title })
  const distinctCourses = Object.entries(courseMap).map(([id, title]) => ({ id, title }))

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900 flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-primary" /> Retours pilote
        </h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {rows.length} réponse{rows.length !== 1 ? 's' : ''} collectée{rows.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Stats cards */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {[
            { label: 'Note globale',        value: overallAvg,   suffix: '/5' },
            { label: 'Clarté',              value: clarityAvg,   suffix: '/5' },
            { label: 'Valeur pratique',      value: practicalAvg, suffix: '/5' },
            { label: 'Facilité d\'usage',    value: easeAvg,      suffix: '/5' },
            { label: 'Recommandations',      value: `${recommendYes}↑ ${recommendNo}↓`, suffix: '' },
          ].map(({ label, value, suffix }) => (
            <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <p className="text-xl font-extrabold text-primary">{value}<span className="text-xs text-gray-400 font-normal">{suffix}</span></p>
              <p className="text-xs text-gray-400 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Course filter */}
      {distinctCourses.length > 1 && (
        <form className="flex gap-2 flex-wrap">
          <a
            href="/admin/feedback"
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${!courseFilter ? 'bg-primary text-white border-primary' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}
          >
            Toutes
          </a>
          {distinctCourses.map(c => (
            <a
              key={c.id}
              href={`/admin/feedback?course=${c.id}`}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${courseFilter === c.id ? 'bg-primary text-white border-primary' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}
            >
              {c.title}
            </a>
          ))}
        </form>
      )}

      {/* Feedback list */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm py-16 text-center">
          <MessageSquare className="w-10 h-10 mx-auto mb-3 text-gray-200" />
          <p className="text-sm text-gray-400">Aucun retour collecté pour l&apos;instant</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map(row => {
            const name = row.profiles?.full_name || row.profiles?.email || 'Anonyme'
            return (
              <div key={row.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                {/* Top row */}
                <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{name}</p>
                    <p className="text-xs text-gray-400">{row.courses?.title ?? '—'} · {new Date(row.created_at).toLocaleDateString('fr-FR', { dateStyle: 'medium' })}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {row.would_recommend === true  && <span className="inline-flex items-center gap-1 text-xs text-success font-semibold bg-success/10 px-2 py-0.5 rounded-full"><ThumbsUp className="w-3 h-3" /> Recommande</span>}
                    {row.would_recommend === false && <span className="inline-flex items-center gap-1 text-xs text-red-600 font-semibold bg-red-50 px-2 py-0.5 rounded-full"><ThumbsDown className="w-3 h-3" /> Ne recommande pas</span>}
                    {row.fair_price && <span className="text-xs bg-amber-50 text-amber-700 font-semibold px-2 py-0.5 rounded-full">Prix juste : {row.fair_price}</span>}
                  </div>
                </div>

                {/* Ratings */}
                <div className="flex flex-wrap gap-4 mb-4">
                  <div><p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Clarté</p><Stars n={row.clarity_rating} /></div>
                  <div><p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Valeur pratique</p><Stars n={row.practical_value_rating} /></div>
                  <div><p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Facilité d&apos;usage</p><Stars n={row.ease_of_use_rating} /></div>
                </div>

                {/* Open answers */}
                {(row.most_useful || row.confusing_part || row.comment) && (
                  <div className="space-y-2 pt-3 border-t border-gray-50">
                    {row.most_useful && (
                      <div>
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Plus utile</p>
                        <p className="text-sm text-gray-700 mt-0.5">{row.most_useful}</p>
                      </div>
                    )}
                    {row.confusing_part && (
                      <div>
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Confus / difficile</p>
                        <p className="text-sm text-gray-700 mt-0.5">{row.confusing_part}</p>
                      </div>
                    )}
                    {row.comment && (
                      <div>
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Commentaire libre</p>
                        <p className="text-sm text-gray-700 mt-0.5">{row.comment}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
