import { type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  icon?: LucideIcon
  trend?: { value: number; label?: string }
  color?: 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'gray'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const colorMap = {
  blue:   { icon: 'bg-blue-100 text-blue-600',   badge: 'bg-blue-50 text-blue-700' },
  green:  { icon: 'bg-green-100 text-green-600', badge: 'bg-green-50 text-green-700' },
  orange: { icon: 'bg-orange-100 text-orange-600', badge: 'bg-orange-50 text-orange-700' },
  red:    { icon: 'bg-red-100 text-red-600',     badge: 'bg-red-50 text-red-700' },
  purple: { icon: 'bg-purple-100 text-purple-600', badge: 'bg-purple-50 text-purple-700' },
  gray:   { icon: 'bg-gray-100 text-gray-600',   badge: 'bg-gray-50 text-gray-700' },
}

export function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  color = 'blue',
  size = 'md',
  className,
}: StatCardProps) {
  const colors = colorMap[color]
  const isPositive = trend && trend.value >= 0

  return (
    <div className={cn(
      'bg-white rounded-xl border border-gray-100 shadow-sm p-3.5 sm:p-5 flex flex-col gap-2 sm:gap-3',
      size === 'sm' && 'sm:p-4',
      size === 'lg' && 'sm:p-6',
      className
    )}>
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-gray-500">{title}</p>
        {Icon && (
          <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', colors.icon)}>
            <Icon className="w-4.5 h-4.5" />
          </div>
        )}
      </div>

      <div className="flex items-end gap-3">
        <p className={cn(
          'font-bold text-gray-900 leading-none',
          size === 'sm' ? 'text-xl sm:text-2xl' : size === 'lg' ? 'text-3xl sm:text-4xl' : 'text-2xl sm:text-3xl'
        )}>
          {value}
        </p>
        {trend && (
          <span className={cn(
            'text-xs font-semibold px-1.5 py-0.5 rounded mb-0.5',
            isPositive
              ? 'bg-green-50 text-green-700'
              : 'bg-red-50 text-red-700'
          )}>
            {isPositive ? '↑' : '↓'} {Math.abs(trend.value)}%
          </span>
        )}
      </div>

      {(subtitle || (trend && trend.label)) && (
        <p className="text-xs text-gray-400">{subtitle ?? trend?.label}</p>
      )}
    </div>
  )
}
