import { requireAuth, requireOrgMembership } from '@/lib/auth/session'
import { getFeedbackEntries } from '@/lib/queries/feedback'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { MessageSquare, Plus, Filter } from 'lucide-react'
import Link from 'next/link'
import type { FeedbackEntry } from '@/types/cx'

interface PageProps {
  params: { orgSlug: string }
  searchParams: { status?: string; channel?: string; page?: string }
}

export default async function FeedbackPage({ params, searchParams }: PageProps) {
  const profile = await requireAuth()
  const { org } = await requireOrgMembership(profile.id, params.orgSlug)

  const page = parseInt(searchParams.page ?? '1')
  const { data: entries, count } = await getFeedbackEntries(
    org.id,
    { status: searchParams.status, channel: searchParams.channel },
    page,
    25
  )

  const totalPages = Math.ceil((count ?? 0) / 25)

  const STATUSES = ['unreviewed', 'reviewed', 'actioned', 'archived']

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto space-y-4 sm:space-y-6">

      {/* Header */}
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Feedback</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {count} {count === 1 ? 'entry' : 'entries'} total
          </p>
        </div>
        <Link
          href={`/app/${params.orgSlug}/feedback/new`}
          className="flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl bg-[#4a6de5] text-white text-sm font-semibold hover:bg-[#3a5dd5] transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Add Feedback</span>
          <span className="sm:hidden">Add</span>
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 shrink-0">
          <Filter className="w-3.5 h-3.5" /> Filter:
        </span>
        {STATUSES.map(s => (
          <Link
            key={s}
            href={`/app/${params.orgSlug}/feedback?status=${s}`}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              searchParams.status === s
                ? 'bg-[#4a6de5] text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:border-[#4a6de5]/40'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </Link>
        ))}
        {searchParams.status && (
          <Link
            href={`/app/${params.orgSlug}/feedback`}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
          >
            Clear
          </Link>
        )}
      </div>

      {/* Feedback list */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {entries.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No feedback found"
            description="Start collecting customer feedback to see it here."
            action={
              <Link
                href={`/app/${params.orgSlug}/feedback/new`}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#4a6de5] text-white text-sm font-semibold"
              >
                <Plus className="w-4 h-4" /> Add your first entry
              </Link>
            }
          />
        ) : (
          <div className="divide-y divide-gray-50">

            {/* Desktop table header — hidden on mobile */}
            <div className="hidden sm:grid sm:grid-cols-[1fr_80px_100px_100px_120px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Content</span>
              <span>Score</span>
              <span>Channel</span>
              <span>Status</span>
              <span>Date</span>
            </div>

            {entries.map((entry: FeedbackEntry) => {
              const dateStr = new Date(entry.collected_at).toLocaleDateString('en', {
                month: 'short', day: 'numeric', year: 'numeric',
              })
              const scoreColor = entry.sentiment === 'positive'
                ? 'bg-green-50 text-green-700'
                : entry.sentiment === 'negative'
                ? 'bg-red-50 text-red-700'
                : 'bg-gray-50 text-gray-600'

              return (
                <Link
                  key={entry.id}
                  href={`/app/${params.orgSlug}/feedback/${entry.id}`}
                  className="block hover:bg-gray-50 transition-colors"
                >
                  {/* Desktop row */}
                  <div className="hidden sm:grid sm:grid-cols-[1fr_80px_100px_100px_120px] gap-4 px-5 py-4 items-center">
                    <div className="min-w-0">
                      {entry.content
                        ? <p className="text-sm text-gray-700 line-clamp-2 leading-relaxed">{entry.content}</p>
                        : <span className="text-sm italic text-gray-400">No text</span>}
                    </div>
                    <div>
                      {entry.score !== null
                        ? <span className={`inline-flex items-center justify-center w-9 h-9 rounded-lg text-sm font-bold ${scoreColor}`}>{entry.score}</span>
                        : <span className="text-gray-300">—</span>}
                    </div>
                    <span className="text-xs text-gray-500 capitalize">{entry.channel}</span>
                    <StatusBadge status={entry.status} size="sm" />
                    <span className="text-xs text-gray-400">{dateStr}</span>
                  </div>

                  {/* Mobile card */}
                  <div className="sm:hidden px-4 py-3.5 space-y-2">
                    <div className="flex items-start gap-3">
                      {entry.score !== null && (
                        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-lg text-sm font-bold shrink-0 ${scoreColor}`}>
                          {entry.score}
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        {entry.content
                          ? <p className="text-sm text-gray-700 line-clamp-3 leading-relaxed">{entry.content}</p>
                          : <span className="text-sm italic text-gray-400">No text</span>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={entry.status} size="sm" />
                      <span className="text-xs text-gray-400 capitalize">{entry.channel}</span>
                      <span className="text-xs text-gray-300">·</span>
                      <span className="text-xs text-gray-400">{dateStr}</span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center flex-wrap gap-2">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <Link
              key={p}
              href={`/app/${params.orgSlug}/feedback?page=${p}${searchParams.status ? `&status=${searchParams.status}` : ''}`}
              className={`w-9 h-9 flex items-center justify-center rounded-lg text-sm font-medium transition-colors ${
                p === page ? 'bg-[#4a6de5] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-[#4a6de5]/40'
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
