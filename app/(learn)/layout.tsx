import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import Header from '@/components/layout/Header'

export default async function LearnLayout({ children }: { children: React.ReactNode }) {
  if (!PILOT_MODE) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) redirect('/login')
  }

  return (
    <>
      <Header compact />
      <main className="pt-[48px]">{children}</main>
    </>
  )
}
