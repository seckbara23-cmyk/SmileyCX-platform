import { createClient } from '@supabase/supabase-js'

/**
 * Supabase client that uses the service role key.
 * ONLY use this in Server Actions and Server Components — never on the client.
 * Requires SUPABASE_SERVICE_ROLE_KEY to be set in .env.local.
 */
export function createAdminClient() {
  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key || key === 'YOUR_SERVICE_ROLE_KEY') {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured. ' +
      'Add it to .env.local from Supabase → Settings → API → service_role key.'
    )
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession:   false,
    },
  })
}
