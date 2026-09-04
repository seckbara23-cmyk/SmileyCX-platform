import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind classes safely (handles conflicts). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a price with currency symbol */
export function formatPrice(amount: number, currency = 'XOF'): string {
  if (currency === 'XOF') {
    return `${amount.toLocaleString('fr-FR')} FCFA`
  }
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(amount)
}

/** Format a date */
export function formatDate(dateStr: string, locale = 'fr-FR'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(dateStr))
}

/** Generate a unique payment reference */
export function generateReference(prefix = 'SCX'): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `${prefix}-${timestamp}-${random}`
}

/** Map level to label */
export const LEVEL_LABELS: Record<string, string> = {
  // PILOT-UX-1: learner-facing label for the first journey is 'Fondations'.
  // The DB value stays 'beginner' — this map is presentation only.
  beginner:     'Fondations',
  intermediate: 'Intermédiaire',
  advanced:     'Avancé',
}

/** Map payment method to display info */
export const PAYMENT_METHOD_INFO = {
  orange_money: { label: 'Orange Money', color: 'bg-orange-500', icon: '🟠' },
  wave:         { label: 'Wave',         color: 'bg-blue-600',   icon: '🔵' },
  card:         { label: 'Carte bancaire', color: 'bg-gray-700', icon: '💳' },
} as const
