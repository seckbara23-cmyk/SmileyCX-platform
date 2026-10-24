'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

/**
 * "Commencer ma formation" — the closing CTA (XP-BRAND-01 §11).
 *
 * A new visitor is sent to registration; someone already signed in goes to the
 * catalogue. It resolves that client-side, with the same browser Supabase
 * client the Header already uses, for two reasons: it reuses the existing
 * authentication logic rather than inventing a second one, and it keeps the
 * home page statically rendered — reading the session on the server would make
 * `/` dynamic for every anonymous visitor to serve one button.
 *
 * `/signup` is the default while the session is still unknown, so the link is
 * never dead and never promises course access before it has been granted.
 * Routing is all this does: registration restrictions and entitlement checks
 * live on those destinations and are untouched.
 */
export default function FinalCtaButton() {
  const [href, setHref] = useState('/signup')

  useEffect(() => {
    let active = true
    createClient().auth.getUser().then(({ data }) => {
      if (active && data.user) setHref('/courses')
    }).catch(() => { /* stay on /signup */ })
    return () => { active = false }
  }, [])

  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-white text-primary font-bold rounded-cx hover:bg-white/90 transition-all hover:-translate-y-0.5"
    >
      Commencer ma formation <ArrowRight className="w-5 h-5" />
    </Link>
  )
}
