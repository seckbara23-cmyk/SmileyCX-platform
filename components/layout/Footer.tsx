'use client'
import Link from 'next/link'
import Image from 'next/image'
import { Mail, Phone, MapPin, Linkedin } from 'lucide-react'
import {
  CONTACT_EMAIL, CONTACT_PHONE, CONTACT_PHONE_HREF, CONTACT_LOCATION,
  BRAND_LEGAL_NAME,
} from '@/lib/brand'

/**
 * Public footer (XP-BRAND-01 §9).
 *
 * Three balanced zones — identity, quick links, official contact — replacing
 * the previous four-column layout. Removed deliberately:
 *
 *   • the "Nos Services" column (Stratégie CX, Parcours Client, Voix du Client,
 *     Expérience Employé, Mesure & Analyse, Formation CX). Every one of those
 *     six pointed at /courses; they advertised consulting services the academy
 *     does not sell here.
 *   • the "Admin" link. The administration ROUTES are untouched and RBAC is
 *     unchanged — the link simply stops being advertised to visitors and
 *     learners, which is all the brief asks.
 *   • the newsletter form, which was an `onSubmit={e => e.preventDefault()}`
 *     stub: it collected an address and discarded it.
 *
 * The logo sits on a white panel because the footer ground is #111827 and the
 * official wordmark is navy — it would be unreadable directly on the dark
 * surface, and recolouring the artwork is exactly what the brief forbids.
 */

/**
 * Social links are rendered ONLY when a verified destination is configured.
 * The brief says LinkedIn is ready and must point at the official page, but
 * supplies no URL, and it also says not to invent URLs or show broken links.
 * So the icon appears the moment NEXT_PUBLIC_LINKEDIN_URL is set, and not
 * before. The other networks are still being created and stay absent.
 */
const LINKEDIN_URL = process.env.NEXT_PUBLIC_LINKEDIN_URL ?? ''

const QUICK_LINKS = [
  { href: '/',         label: 'Accueil' },
  { href: '/courses',  label: 'Formations' },
  { href: '/about',    label: 'À propos' },
  { href: '/contact',  label: 'Contact' },
]

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="bg-footer text-white/80">
      <div className="cx-container py-14">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-10 md:gap-8">

          {/* ── Zone 1 — official logo + positioning ───────────────────── */}
          <div className="md:col-span-5">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <Link href="/" aria-label="XP Client Academy — accueil" className="shrink-0">
                <span className="inline-flex bg-white rounded-cx p-3">
                  {/* Intrinsic 600×432; width/height keep the official ratio. */}
                  <Image
                    src="/brand/xp-client-academy-logo.png"
                    alt="XP Client Academy"
                    width={600}
                    height={432}
                    className="h-12 w-auto"
                    sizes="167px"
                  />
                </span>
              </Link>
              <p className="text-sm text-white/60 leading-relaxed">
                Des formations pratiques en expérience client, accessibles en ligne
                et adaptées à votre rythme.
              </p>
            </div>

            {LINKEDIN_URL && (
              <div className="flex gap-2.5 mt-6">
                <a
                  href={LINKEDIN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="LinkedIn"
                  className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center text-white/70 hover:bg-secondary hover:text-white transition-colors duration-300"
                >
                  <Linkedin className="w-4 h-4" />
                </a>
              </div>
            )}
          </div>

          {/* ── Zone 2 — quick links ───────────────────────────────────── */}
          <nav className="md:col-span-3" aria-label="Liens rapides">
            <h2 className="text-sm font-bold text-white mb-4 uppercase tracking-wider">
              Liens rapides
            </h2>
            <ul className="flex flex-col gap-2.5">
              {QUICK_LINKS.map(l => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-sm text-white/55 hover:text-white transition-colors"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* ── Zone 3 — official contact ──────────────────────────────── */}
          <div className="md:col-span-4">
            <h2 className="text-sm font-bold text-white mb-4 uppercase tracking-wider">
              Contact
            </h2>
            <div className="flex flex-col gap-3">
              <p className="flex items-start gap-3 text-sm text-white/60">
                <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-secondary" />
                <span>{CONTACT_LOCATION}</span>
              </p>
              <p className="flex items-center gap-3 text-sm text-white/60">
                <Phone className="w-4 h-4 shrink-0 text-secondary" />
                <a href={CONTACT_PHONE_HREF} className="hover:text-white transition-colors">
                  {CONTACT_PHONE}
                </a>
              </p>
              <p className="flex items-center gap-3 text-sm text-white/60">
                <Mail className="w-4 h-4 shrink-0 text-secondary" />
                <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white transition-colors break-all">
                  {CONTACT_EMAIL}
                </a>
              </p>
            </div>
          </div>
        </div>

        {/* ── Bottom row ───────────────────────────────────────────────── */}
        <hr className="border-white/10 mt-10 mb-5" />
        <div className="flex flex-col sm:flex-row justify-between items-center gap-3 text-xs text-white/40">
          <p>© {year} {BRAND_LEGAL_NAME}. Tous droits réservés.</p>
          {/* Only pages that exist. There is no /legal route, so "mentions
              légales" is not linked rather than linked to a 404. */}
          <div className="flex gap-4">
            <Link href="/privacy" className="hover:text-white/70 transition-colors">Confidentialité</Link>
            <Link href="/terms"   className="hover:text-white/70 transition-colors">CGU</Link>
          </div>
        </div>
        <div className="mt-5 flex justify-center">
          <a
            href="https://terangatechnologies.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-white/25 hover:text-white/50 transition-colors duration-200 tracking-wide"
          >
            Plateforme conçue par Teranga Technologies
          </a>
        </div>
      </div>
    </footer>
  )
}
