'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X, ChevronDown, User, LayoutDashboard, LogOut, BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { createClient } from '@/lib/supabase/client'
import { PILOT_MODE } from '@/lib/pilot'
import type { Profile } from '@/types'

const NAV_LINKS = [
  { id: 'accueil',    label: 'Accueil' },
  { id: 'formations', label: 'Formations' },
  { id: 'a-propos',   label: 'À propos' },
  { id: 'contact',    label: 'Contact' },
]

export default function Header() {
  const [scrolled,      setScrolled]      = useState(false)
  const [menuOpen,      setMenuOpen]      = useState(false)
  const [dropOpen,      setDropOpen]      = useState(false)
  const [activeSection, setActiveSection] = useState('accueil')
  const [profile,       setProfile]       = useState<Profile | null>(null)
  const dropRef  = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const supabase = createClient()
  const isHome   = pathname === '/'

  // Scroll detection
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Active section via IntersectionObserver (home page only)
  useEffect(() => {
    if (!isHome) return
    const observers = NAV_LINKS.map(({ id }) => {
      const el = document.getElementById(id)
      if (!el) return null
      const obs = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) setActiveSection(id) },
        { rootMargin: '-30% 0px -60% 0px' }
      )
      obs.observe(el)
      return obs
    })
    return () => observers.forEach(o => o?.disconnect())
  }, [isHome])

  // Auth state
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        supabase.from('profiles').select('*').eq('id', user.id).single()
          .then(({ data }) => setProfile(data))
      }
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) { setProfile(null); return }
      supabase.from('profiles').select('*').eq('id', session.user.id).single()
        .then(({ data }) => setProfile(data))
    })
    return () => subscription.unsubscribe()
  }, [supabase])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    setProfile(null)
    setDropOpen(false)
  }

  function handleNavClick(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    if (isHome) {
      e.preventDefault()
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
    }
    setMenuOpen(false)
  }

  return (
    <header
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transition-all duration-300',
        'bg-white/95 backdrop-blur-md',
        scrolled ? 'shadow-md' : 'shadow-sm'
      )}
    >
      {/* Scroll progress bar */}
      <div id="scroll-progress" />

      <div className="cx-container">
        <nav className="flex items-center justify-between py-4" aria-label="Navigation principale">
          {/* Logo */}
          <a
            href="/#accueil"
            onClick={(e) => handleNavClick(e, 'accueil')}
            className="text-2xl font-extrabold text-primary tracking-tight shrink-0"
          >
            Smiley<span className="text-secondary">CX</span>{' '}
            <span className="text-lg font-semibold text-cx-gray">Academy</span>
          </a>

          {/* Desktop nav */}
          <ul className="hidden md:flex items-center gap-1 list-none">
            {NAV_LINKS.map(link => (
              <li key={link.id}>
                <a
                  href={`/#${link.id}`}
                  onClick={(e) => handleNavClick(e, link.id)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-sm font-bold transition-colors duration-200 cursor-pointer',
                    isHome && activeSection === link.id
                      ? 'text-primary bg-primary/8'
                      : 'text-dark hover:text-primary hover:bg-primary/5'
                  )}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>

          {/* Desktop auth */}
          <div className="hidden md:flex items-center gap-3">
            {profile ? (
              <div className="relative" ref={dropRef}>
                <button
                  onClick={() => setDropOpen(o => !o)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-light transition-colors text-sm font-medium text-dark"
                >
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-white text-xs font-bold">
                    {(profile.full_name || profile.email).charAt(0).toUpperCase()}
                  </div>
                  <span className="hidden lg:block max-w-[120px] truncate">
                    {profile.full_name || profile.email}
                  </span>
                  <ChevronDown className={cn('w-4 h-4 transition-transform', dropOpen && 'rotate-180')} />
                </button>

                {dropOpen && (
                  <div className="absolute right-0 top-full mt-2 w-52 bg-white rounded-cx shadow-lg border border-black/[0.06] py-1.5 z-50">
                    <Link
                      href="/dashboard"
                      onClick={() => setDropOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-dark hover:bg-light transition-colors"
                    >
                      <LayoutDashboard className="w-4 h-4 text-primary" />
                      Mon espace
                    </Link>
                    <Link
                      href="/courses"
                      onClick={() => setDropOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-dark hover:bg-light transition-colors"
                    >
                      <BookOpen className="w-4 h-4 text-primary" />
                      Mes formations
                    </Link>
                    {profile.platform_role === 'super_admin' && (
                      <Link
                        href="/admin"
                        onClick={() => setDropOpen(false)}
                        className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-dark hover:bg-light transition-colors"
                      >
                        <User className="w-4 h-4 text-primary" />
                        Administration
                      </Link>
                    )}
                    <hr className="my-1 border-black/[0.06]" />
                    <button
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-error hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Se déconnecter
                    </button>
                  </div>
                )}
              </div>
            ) : PILOT_MODE ? (
              <Link
                href="/courses"
                className="px-5 py-2 text-sm font-semibold bg-secondary text-white rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5"
              >
                Acc&eacute;der aux formations
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="px-4 py-2 text-sm font-semibold text-dark hover:text-primary transition-colors"
                >
                  Connexion
                </Link>
                <Link
                  href="/signup"
                  className="px-5 py-2 text-sm font-semibold bg-secondary text-white rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5"
                >
                  S&apos;inscrire
                </Link>
              </>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden p-2 rounded-lg hover:bg-light transition-colors"
            onClick={() => setMenuOpen(o => !o)}
            aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </nav>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden bg-white border-t border-black/[0.06] px-4 py-4 flex flex-col gap-2">
          {NAV_LINKS.map(link => (
            <a
              key={link.id}
              href={`/#${link.id}`}
              onClick={(e) => handleNavClick(e, link.id)}
              className={cn(
                'px-4 py-3 rounded-cx text-sm font-bold transition-colors cursor-pointer',
                isHome && activeSection === link.id
                  ? 'text-primary bg-primary/8'
                  : 'text-dark hover:bg-light'
              )}
            >
              {link.label}
            </a>
          ))}
          <hr className="border-black/[0.06] my-1" />
          {profile ? (
            <>
              <Link href="/dashboard" onClick={() => setMenuOpen(false)}
                className="px-4 py-3 text-sm font-medium text-dark hover:bg-light rounded-cx transition-colors">
                Mon espace
              </Link>
              {profile.platform_role === 'super_admin' && (
                <Link href="/admin" onClick={() => setMenuOpen(false)}
                  className="px-4 py-3 text-sm font-medium text-dark hover:bg-light rounded-cx transition-colors">
                  Administration
                </Link>
              )}
              <button onClick={() => { handleSignOut(); setMenuOpen(false) }}
                className="px-4 py-3 text-sm font-medium text-error hover:bg-red-50 rounded-cx transition-colors text-left">
                Se déconnecter
              </button>
            </>
          ) : PILOT_MODE ? (
            <Link
              href="/courses"
              onClick={() => setMenuOpen(false)}
              className="px-4 py-3 text-sm font-semibold text-center bg-secondary text-white rounded-cx hover:bg-secondary-dark transition-colors"
            >
              Acc&eacute;der aux formations
            </Link>
          ) : (
            <>
              <Link href="/login" onClick={() => setMenuOpen(false)}
                className="px-4 py-3 text-sm font-medium text-dark hover:bg-light rounded-cx transition-colors">
                Connexion
              </Link>
              <Link href="/signup" onClick={() => setMenuOpen(false)}
                className="px-4 py-3 text-sm font-semibold text-center bg-secondary text-white rounded-cx hover:bg-secondary-dark transition-colors">
                S&apos;inscrire gratuitement
              </Link>
            </>
          )}
        </div>
      )}
    </header>
  )
}
