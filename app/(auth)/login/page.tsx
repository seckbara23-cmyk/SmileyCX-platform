import { headers } from 'next/headers'
import { isAdminHost, resolveHost } from '@/lib/hosts'
import LoginForm from './LoginForm'

// `searchParams` access makes this page dynamic (rendered per-request, not
// statically pre-built). This is intentional: the login page must reflect the
// ?next= and ?error= query params at request time, and must never be cached as
// a static asset.
//
// CX-AUTH-1 adds a second, stronger reason: the page is now host-dependent, so
// a cached copy must never be shared between the public marketing site and the
// private administration portal. force-dynamic makes that explicit rather than
// relying on searchParams access as an implicit opt-out.
export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string }
}) {
  const adminPortal = isAdminHost(resolveHost(await headers()))

  return (
    <LoginForm
      next={searchParams.next}
      error={searchParams.error}
      adminPortal={adminPortal}
    />
  )
}
