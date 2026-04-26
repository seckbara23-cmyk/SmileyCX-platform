'use client'
import { cn } from '@/lib/utils/cn'
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export function Input({ label, error, hint, className, id, required, ...props }: InputProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-semibold text-dark">
          {label}
          {required && <span className="text-error ml-0.5">*</span>}
        </label>
      )}
      <input
        id={inputId}
        required={required}
        className={cn(
          'w-full px-3.5 py-3 rounded-cx border border-[#dde2f0] text-dark text-sm',
          'transition-all duration-300 outline-none bg-white',
          'placeholder:text-cx-gray/70',
          'focus:border-primary focus:ring-3 focus:ring-primary/15',
          error && 'border-error ring-3 ring-error/10',
          className
        )}
        {...props}
      />
      {hint  && !error && <p className="text-xs text-cx-gray">{hint}</p>}
      {error && <p className="text-xs text-error font-medium">{error}</p>}
    </div>
  )
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}

export function Textarea({ label, error, className, id, required, ...props }: TextareaProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-semibold text-dark">
          {label}
          {required && <span className="text-error ml-0.5">*</span>}
        </label>
      )}
      <textarea
        id={inputId}
        required={required}
        className={cn(
          'w-full px-3.5 py-3 rounded-cx border border-[#dde2f0] text-dark text-sm',
          'transition-all duration-300 outline-none bg-white resize-vertical min-h-[120px]',
          'placeholder:text-cx-gray/70',
          'focus:border-primary focus:ring-3 focus:ring-primary/15',
          error && 'border-error ring-3 ring-error/10',
          className
        )}
        {...props}
      />
      {error && <p className="text-xs text-error font-medium">{error}</p>}
    </div>
  )
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  options: { value: string; label: string }[]
  placeholder?: string
}

export function Select({ label, error, options, placeholder, className, id, required, ...props }: SelectProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-semibold text-dark">
          {label}
          {required && <span className="text-error ml-0.5">*</span>}
        </label>
      )}
      <select
        id={inputId}
        required={required}
        className={cn(
          'w-full px-3.5 py-3 rounded-cx border border-[#dde2f0] text-dark text-sm',
          'transition-all duration-300 outline-none bg-white',
          'focus:border-primary focus:ring-3 focus:ring-primary/15',
          error && 'border-error ring-3 ring-error/10',
          className
        )}
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {error && <p className="text-xs text-error font-medium">{error}</p>}
    </div>
  )
}
