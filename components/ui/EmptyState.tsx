import { type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center text-center',
      size === 'sm' ? 'py-8 px-4' : size === 'lg' ? 'py-20 px-6' : 'py-14 px-5',
      className
    )}>
      {Icon && (
        <div className={cn(
          'rounded-2xl bg-gray-50 flex items-center justify-center mb-4',
          size === 'sm' ? 'w-12 h-12' : size === 'lg' ? 'w-20 h-20' : 'w-16 h-16'
        )}>
          <Icon className={cn(
            'text-gray-300',
            size === 'sm' ? 'w-6 h-6' : size === 'lg' ? 'w-10 h-10' : 'w-8 h-8'
          )} />
        </div>
      )}
      <h3 className={cn(
        'font-semibold text-gray-700',
        size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-xl' : 'text-base'
      )}>
        {title}
      </h3>
      {description && (
        <p className={cn(
          'text-gray-400 mt-1 max-w-sm',
          size === 'sm' ? 'text-xs' : 'text-sm'
        )}>
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
