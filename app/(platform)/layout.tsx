import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import Header from '@/components/layout/Header'
import Footer from '@/components/layout/Footer'

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  if (!PILOT_MODE) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) redirect('/login')
  }

  return (
    <>
      <Header />
      <main className="pt-[72px] min-h-[calc(100vh-72px)]">{children}</main>
      <Footer />
    </>
  )
}
