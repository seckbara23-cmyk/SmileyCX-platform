'use client'
import { cn } from '@/lib/utils/cn'
import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  fullWidth?: boolean
  as?: 'button' | 'a'
  href?: string
}

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const base = cn(
    'inline-flex items-center justify-center gap-2 font-semibold rounded-cx',
    'transition-all duration-300 cursor-pointer select-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2',
    {
      // Variants
      'bg-secondary text-white border-2 border-secondary hover:bg-secondary-dark hover:border-secondary-dark hover:-translate-y-0.5 hover:shadow-btn active:translate-y-0':
        variant === 'primary',
      'bg-transparent text-primary border-2 border-primary hover:bg-primary hover:text-white hover:-translate-y-0.5':
        variant === 'outline',
      'bg-transparent text-cx-gray border-2 border-transparent hover:bg-light hover:text-dark':
        variant === 'ghost',
      'bg-red-600 text-white border-2 border-red-600 hover:bg-red-700 hover:border-red-700 hover:-translate-y-0.5':
        variant === 'danger',
      // Sizes
      'px-4 py-2 text-sm':    size === 'sm',
      'px-6 py-3 text-base':  size === 'md',
      'px-8 py-4 text-lg':    size === 'lg',
      // States
      'w-full':  fullWidth,
      'opacity-60 cursor-not-allowed pointer-events-none': disabled || loading,
    },
    className
  )

  return (
    <button className={base} disabled={disabled || loading} {...props}>
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  )
}
