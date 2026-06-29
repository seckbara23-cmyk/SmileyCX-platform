import LoginForm from './LoginForm'

// `searchParams` access makes this page dynamic (rendered per-request, not
// statically pre-built). This is intentional: the login page must reflect the
// ?next= and ?error= query params at request time, and must never be cached as
// a static asset.
export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string }
}) {
  return (
    <LoginForm
      next={searchParams.next}
      error={searchParams.error}
    />
  )
}
