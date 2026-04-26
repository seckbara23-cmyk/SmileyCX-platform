import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function CompanyLayout() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Legacy company workspace is not available in the current launch build.
  return redirect('/dashboard')
}
