import { cn } from '@/lib/utils/cn'
import type { IssueStatus, ActionStatus, FeedbackStatus } from '@/types/cx'

type AnyStatus = IssueStatus | ActionStatus | FeedbackStatus | string

const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  // Issue statuses
  open:        { label: 'Open',        classes: 'bg-blue-50 text-blue-700 border-blue-100' },
  in_progress: { label: 'In Progress', classes: 'bg-yellow-50 text-yellow-700 border-yellow-100' },
  resolved:    { label: 'Resolved',    classes: 'bg-green-50 text-green-700 border-green-100' },
  closed:      { label: 'Closed',      classes: 'bg-gray-100 text-gray-500 border-gray-200' },
  // Action statuses
  planned:     { label: 'Planned',     classes: 'bg-purple-50 text-purple-700 border-purple-100' },
  completed:   { label: 'Completed',   classes: 'bg-green-50 text-green-700 border-green-100' },
  cancelled:   { label: 'Cancelled',   classes: 'bg-gray-100 text-gray-500 border-gray-200' },
  // Feedback statuses
  unreviewed:  { label: 'Unreviewed',  classes: 'bg-orange-50 text-orange-700 border-orange-100' },
  reviewed:    { label: 'Reviewed',    classes: 'bg-blue-50 text-blue-700 border-blue-100' },
  actioned:    { label: 'Actioned',    classes: 'bg-green-50 text-green-700 border-green-100' },
  archived:    { label: 'Archived',    classes: 'bg-gray-100 text-gray-500 border-gray-200' },
  // Org/plan
  active:      { label: 'Active',      classes: 'bg-green-50 text-green-700 border-green-100' },
  trial:       { label: 'Trial',       classes: 'bg-blue-50 text-blue-700 border-blue-100' },
  suspended:   { label: 'Suspended',   classes: 'bg-red-50 text-red-700 border-red-100' },
  draft:       { label: 'Draft',       classes: 'bg-gray-50 text-gray-500 border-gray-100' },
}

interface StatusBadgeProps {
  status: AnyStatus
  size?: 'sm' | 'md'
  className?: string
}

export function StatusBadge({ status, size = 'md', className }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? { label: status, classes: 'bg-gray-100 text-gray-600 border-gray-200' }

  return (
    <span className={cn(
      'inline-flex items-center font-medium rounded-full border',
      size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs',
      config.classes,
      className
    )}>
      {config.label}
    </span>
  )
}
