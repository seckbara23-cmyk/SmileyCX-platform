import { redirect } from 'next/navigation'
import { requireAuth, getUserMemberships } from '@/lib/auth/session'

// Outer app shell — just verifies auth and redirects accordingly
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireAuth()
  const memberships = await getUserMemberships(profile.id)

  // No orgs → send to onboarding
  if (memberships.length === 0) {
    redirect('/app/onboarding')
  }

  return <>{children}</>
}
