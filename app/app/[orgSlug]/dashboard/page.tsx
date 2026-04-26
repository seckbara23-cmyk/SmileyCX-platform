import { requireAuth, requireOrgMembership } from '@/lib/auth/session'
import { getDashboardFeedbackStats } from '@/lib/queries/feedback'
import { getOverdueActions, getOpenIssuesCount } from '@/lib/queries/actions'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { PriorityBadge } from '@/components/ui/PriorityBadge'
import { createClient } from '@/lib/supabase/server'
import {
  MessageSquare, TrendingUp, AlertTriangle, CheckCircle2,
  Zap, Clock, ArrowRight, Plus
} from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: { orgSlug: string }
}

export default async function DashboardPage({ params }: PageProps) {
  const profile = await requireAuth()
  const { org } = await requireOrgMembership(profile.id, params.orgSlug)

  const [feedbackStats, overdueCount, openIssues, recentActions, topTouchpoints] = await Promise.all([
    getDashboardFeedbackStats(org.id),
    getOverdueActions(org.id),
    getOpenIssuesCount(org.id),
    // Recent action plans
    createClient().then(sb => sb
      .from('action_plans')
      .select('id, title, status, priority, due_date, owner:profiles!owner_id(full_name,email)')
      .eq('org_id', org.id)
      .in('status', ['planned', 'in_progress'])
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(5)
      .then(r => r.data ?? [])
    ),
    // Worst touchpoints by avg score
    createClient().then(sb => sb
      .from('touchpoints')
      .select('id, name, channel, avg_score, feedback_count')
      .eq('org_id', org.id)
      .not('avg_score', 'is', null)
      .order('avg_score', { ascending: true })
      .limit(5)
      .then(r => r.data ?? [])
    ),
  ])

  const npsDisplay = feedbackStats.nps !== null ? feedbackStats.nps : '—'
  const csatDisplay = feedbackStats.csat !== null ? `${feedbackStats.csat}/5` : '—'

  return (
    <div className="p-3 sm:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-8">
      {/* Page header */}
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-400 mt-0.5">Customer experience overview for {org.name}</p>
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

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard
          title="NPS Score"
          value={npsDisplay}
          subtitle="Last 30 days"
          icon={TrendingUp}
          color="blue"
        />
        <StatCard
          title="CSAT"
          value={csatDisplay}
          subtitle="Last 30 days"
          icon={CheckCircle2}
          color="green"
        />
        <StatCard
          title="Feedback Volume"
          value={feedbackStats.feedback_count}
          subtitle="Last 30 days"
          icon={MessageSquare}
          color="purple"
        />
        <StatCard
          title="Open Issues"
          value={openIssues}
          subtitle={overdueCount > 0 ? `${overdueCount} overdue` : 'All on track'}
          icon={AlertTriangle}
          color={overdueCount > 0 ? 'red' : 'gray'}
        />
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Recent feedback */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
            <h2 className="font-bold text-gray-800">Recent Feedback</h2>
            <Link
              href={`/app/${params.orgSlug}/feedback`}
              className="text-xs text-[#4a6de5] font-semibold hover:underline flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {feedbackStats.recent_feedback.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No feedback yet"
              description="Add your first feedback entry to get started."
              size="sm"
            />
          ) : (
            <div className="divide-y divide-gray-50">
              {feedbackStats.recent_feedback.map((f: {
                id: string
                score_type: string | null
                score: number | null
                content: string | null
                channel: string
                sentiment: string | null
                collected_at: string
              }) => (
                <Link
                  key={f.id}
                  href={`/app/${params.orgSlug}/feedback/${f.id}`}
                  className="flex items-start gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors"
                >
                  {f.score !== null && (
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${
                      f.sentiment === 'positive' ? 'bg-green-100 text-green-700' :
                      f.sentiment === 'negative' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {f.score}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700 line-clamp-2 leading-relaxed">
                      {f.content || <span className="italic text-gray-400">No text</span>}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[11px] text-gray-400 capitalize">{f.channel}</span>
                      {f.score_type && (
                        <span className="text-[11px] text-gray-300">·</span>
                      )}
                      {f.score_type && (
                        <span className="text-[11px] text-gray-400 uppercase">{f.score_type}</span>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Open actions */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
            <h2 className="font-bold text-gray-800">Open Actions</h2>
            <Link
              href={`/app/${params.orgSlug}/actions`}
              className="text-xs text-[#4a6de5] font-semibold hover:underline flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {recentActions.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No open actions"
              description="Create action plans to track CX improvements."
              size="sm"
            />
          ) : (
            <div className="divide-y divide-gray-50">
              {recentActions.map((a: {
                id: string
                title: string
                status: string
                priority: string
                due_date: string | null
                owner: { full_name: string | null; email: string }[] | { full_name: string | null; email: string } | null
              }) => {
                const isOverdue = a.due_date && new Date(a.due_date) < new Date()
                return (
                  <Link
                    key={a.id}
                    href={`/app/${params.orgSlug}/actions`}
                    className="flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{a.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {a.due_date && (
                          <span className={`flex items-center gap-1 text-[11px] ${isOverdue ? 'text-red-500' : 'text-gray-400'}`}>
                            <Clock className="w-3 h-3" />
                            {new Date(a.due_date).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                            {isOverdue && ' · Overdue'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <PriorityBadge priority={a.priority as 'critical' | 'high' | 'medium' | 'low'} size="sm" showDot />
                      <StatusBadge status={a.status} size="sm" />
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Worst touchpoints */}
      {topTouchpoints.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
            <h2 className="font-bold text-gray-800">Underperforming Touchpoints</h2>
            <Link
              href={`/app/${params.orgSlug}/journeys`}
              className="text-xs text-[#4a6de5] font-semibold hover:underline flex items-center gap-1"
            >
              View journeys <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-gray-50">
            {topTouchpoints.map((tp: {
              id: string
              name: string
              channel: string
              avg_score: number | null
              feedback_count: number
            }) => (
              <div key={tp.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{tp.name}</p>
                  <p className="text-xs text-gray-400 capitalize">{tp.channel} · {tp.feedback_count} responses</p>
                </div>
                <div className={`text-sm font-bold px-3 py-1 rounded-lg ${
                  tp.avg_score !== null && tp.avg_score >= 4 ? 'bg-green-50 text-green-700' :
                  tp.avg_score !== null && tp.avg_score >= 3 ? 'bg-yellow-50 text-yellow-700' :
                  'bg-red-50 text-red-700'
                }`}>
                  {tp.avg_score?.toFixed(1) ?? '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
