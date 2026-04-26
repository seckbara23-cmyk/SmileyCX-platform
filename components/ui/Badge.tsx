import { cn } from '@/lib/utils/cn'

interface BadgeProps {
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'gray' | 'level'
  className?: string
}

const variantMap = {
  primary:   'bg-primary/10 text-primary',
  secondary: 'bg-secondary/10 text-secondary-dark',
  success:   'bg-green-100 text-green-700',
  warning:   'bg-yellow-100 text-yellow-700',
  gray:      'bg-light text-cx-gray border border-black/[0.08]',
  level:     'bg-primary text-white',
}

export default function Badge({ children, variant = 'gray', className }: BadgeProps) {
  return (
    <span className={cn('cx-badge', variantMap[variant], className)}>
      {children}
    </span>
  )
}
