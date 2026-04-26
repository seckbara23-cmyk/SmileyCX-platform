import { requireAuth, requireOrgMembership } from '@/lib/auth/session'
import { getActionPlans, getIssues } from '@/lib/queries/actions'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { PriorityBadge } from '@/components/ui/PriorityBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Zap, Plus, Clock, User } from 'lucide-react'
import Link from 'next/link'
import type { ActionPlan, Issue } from '@/types/cx'

interface PageProps {
  params: { orgSlug: string }
  searchParams: { tab?: string; status?: string }
}

export default async function ActionsPage({ params, searchParams }: PageProps) {
  const profile = await requireAuth()
  const { org } = await requireOrgMembership(profile.id, params.orgSlug)

  const tab = searchParams.tab ?? 'actions'

  const [actions, issues] = await Promise.all([
    getActionPlans(org.id, { status: searchParams.status }),
    getIssues(org.id, { status: searchParams.status }),
  ])

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto space-y-4 sm:space-y-6">

      {/* Header */}
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Actions</h1>
          <p className="text-sm text-gray-400 mt-0.5">Issues and action plans to improve CX</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl bg-[#4a6de5] text-white text-sm font-semibold hover:bg-[#3a5dd5] transition-colors shrink-0">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">New Action</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {['actions', 'issues'].map(t => (
          <Link
            key={t}
            href={`/app/${params.orgSlug}/actions?tab=${t}`}
            className={`px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-colors capitalize ${
              tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t} {t === 'actions' ? `(${actions.length})` : `(${issues.length})`}
          </Link>
        ))}
      </div>

      {/* ── Actions table ────────────────────────────────────────── */}
      {tab === 'actions' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          {actions.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No action plans yet"
              description="Create action plans to track improvements and assign owners."
              size="md"
            />
          ) : (
            <div className="divide-y divide-gray-50">

              {/* Desktop table header — hidden on mobile */}
              <div className="hidden sm:grid sm:grid-cols-[1fr_120px_100px_110px_120px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
                <span>Action</span>
                <span>Owner</span>
                <span>Priority</span>
                <span>Status</span>
                <span>Due date</span>
              </div>

              {actions.map((a: ActionPlan) => {
                const isOverdue   = a.due_date && new Date(a.due_date) < new Date() && a.status !== 'completed'
                const ownerName   = a.owner?.full_name || a.owner?.email?.split('@')[0] || 'Unassigned'
                const dueDateFmt  = a.due_date
                  ? new Date(a.due_date).toLocaleDateString('en', { month: 'short', day: 'numeric' })
                  : null

                return (
                  <div key={a.id} className="hover:bg-gray-50 transition-colors">

                    {/* ── Desktop row ── */}
                    <div className="hidden sm:grid sm:grid-cols-[1fr_120px_100px_110px_120px] gap-4 px-5 py-4 items-center">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{a.title}</p>
                        {a.description && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">{a.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-gray-500 truncate">
                        <User className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                        <span className="truncate">{ownerName}</span>
                      </div>
                      <PriorityBadge priority={a.priority} size="sm" />
                      <StatusBadge status={a.status} size="sm" />
                      <span className={`flex items-center gap-1 text-xs ${isOverdue ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>
                        {dueDateFmt
                          ? <><Clock className="w-3 h-3" /> {dueDateFmt}{isOverdue ? ' · Overdue' : ''}</>
                          : '—'}
                      </span>
                    </div>

                    {/* ── Mobile card ── */}
                    <div className="sm:hidden px-4 py-3.5 space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-gray-800 flex-1">{a.title}</p>
                        <PriorityBadge priority={a.priority} size="sm" />
                      </div>
                      {a.description && (
                        <p className="text-xs text-gray-400 line-clamp-2">{a.description}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={a.status} size="sm" />
                        <span className="flex items-center gap-1 text-xs text-gray-400">
                          <User className="w-3 h-3" /> {ownerName}
                        </span>
                        {dueDateFmt && (
                          <span className={`flex items-center gap-1 text-xs ${isOverdue ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>
                            <Clock className="w-3 h-3" /> {dueDateFmt}{isOverdue ? ' · Overdue' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Issues table ─────────────────────────────────────────── */}
      {tab === 'issues' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          {issues.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No issues logged"
              description="Log CX issues to track them and link action plans."
              size="md"
            />
          ) : (
            <div className="divide-y divide-gray-50">

              {/* Desktop header */}
              <div className="hidden sm:grid sm:grid-cols-[1fr_120px_100px_110px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
                <span>Issue</span>
                <span>Assigned to</span>
                <span>Priority</span>
                <span>Status</span>
              </div>

              {issues.map((issue: Issue) => {
                const assigneeName = issue.assignee?.full_name || issue.assignee?.email?.split('@')[0] || 'Unassigned'
                return (
                  <div key={issue.id} className="hover:bg-gray-50 transition-colors">

                    {/* Desktop row */}
                    <div className="hidden sm:grid sm:grid-cols-[1fr_120px_100px_110px] gap-4 px-5 py-4 items-center">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{issue.title}</p>
                        {issue.description && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">{issue.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-gray-500 truncate">
                        <User className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                        <span className="truncate">{assigneeName}</span>
                      </div>
                      <PriorityBadge priority={issue.priority} size="sm" />
                      <StatusBadge status={issue.status} size="sm" />
                    </div>

                    {/* Mobile card */}
                    <div className="sm:hidden px-4 py-3.5 space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-gray-800 flex-1">{issue.title}</p>
                        <PriorityBadge priority={issue.priority} size="sm" />
                      </div>
                      {issue.description && (
                        <p className="text-xs text-gray-400 line-clamp-2">{issue.description}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={issue.status} size="sm" />
                        <span className="flex items-center gap-1 text-xs text-gray-400">
                          <User className="w-3 h-3" /> {assigneeName}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
