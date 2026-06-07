/**
 * Access control for PLATFORM_MODE === 'private'.
 *
 * During the pre-launch period, only explicitly listed emails are permitted
 * to access protected platform areas (dashboard, learn, checkout, etc.).
 * Public marketing pages are unaffected.
 *
 * To grant access: add an email to ALLOWED_PRIVATE_EMAILS.
 * To open to the public: switch NEXT_PUBLIC_PLATFORM_MODE to 'public'.
 */
import { PLATFORM_MODE } from '@/lib/pilot'

export const isPrivateMode = PLATFORM_MODE === 'private'

// Emails allowed to access protected routes while platform is private.
// Comparison is case-insensitive.
export const ALLOWED_PRIVATE_EMAILS: ReadonlyArray<string> = [
  'seckbara23@gmail.com',
  'mariemelly@gmail.com',
]

export function isAllowedPrivateUser(email: string): boolean {
  const normalized = email.toLowerCase().trim()
  return ALLOWED_PRIVATE_EMAILS.some(e => e.toLowerCase() === normalized)
}
