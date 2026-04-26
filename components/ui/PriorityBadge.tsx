import { cn } from '@/lib/utils/cn'
import type { IssuePriority } from '@/types/cx'

const PRIORITY_CONFIG: Record<IssuePriority, { label: string; classes: string; dot: string }> = {
  critical: { label: 'Critical', classes: 'bg-red-50 text-red-700',    dot: 'bg-red-500' },
  high:     { label: 'High',     classes: 'bg-orange-50 text-orange-700', dot: 'bg-orange-500' },
  medium:   { label: 'Medium',   classes: 'bg-yellow-50 text-yellow-700', dot: 'bg-yellow-500' },
  low:      { label: 'Low',      classes: 'bg-gray-50 text-gray-600',   dot: 'bg-gray-400' },
}

interface PriorityBadgeProps {
  priority: IssuePriority
  showDot?: boolean
  size?: 'sm' | 'md'
  className?: string
}

export function PriorityBadge({ priority, showDot = true, size = 'md', className }: PriorityBadgeProps) {
  const config = PRIORITY_CONFIG[priority]
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 font-medium rounded-full',
      size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
      config.classes,
      className
    )}>
      {showDot && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', config.dot)} />}
      {config.label}
    </span>
  )
}
