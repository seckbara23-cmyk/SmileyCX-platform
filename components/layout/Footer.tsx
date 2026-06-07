'use client'
import Link from 'next/link'
import { Mail, Phone, MapPin, Facebook, Twitter, Linkedin, Instagram } from 'lucide-react'

const SERVICES_LINKS = [
  'Stratégie CX', 'Parcours Client', 'Voix du Client',
  'Expérience Employé', 'Mesure & Analyse', 'Formation CX',
]

export default function Footer() {
  return (
    <footer className="bg-[#111827] text-white/80">
      <div className="cx-container py-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10">
          {/* Brand */}
          <div>
            <p className="text-2xl font-extrabold text-white mb-3 tracking-tight">
              XP<span className="text-secondary"> Client</span>{' '}
              <span className="text-lg font-semibold text-white/60">Academy</span>
            </p>
            <p className="text-sm text-white/60 leading-relaxed mb-5">
              Développer l&apos;excellence en expérience client pour les individus et les entreprises à travers des formations certifiantes en ligne.
            </p>
            <div className="flex gap-2.5">
              {[
                { Icon: Facebook, label: 'Facebook' },
                { Icon: Twitter,  label: 'Twitter' },
                { Icon: Linkedin, label: 'LinkedIn' },
                { Icon: Instagram, label: 'Instagram' },
              ].map(({ Icon, label }) => (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center text-white/70 hover:bg-primary hover:text-white transition-colors duration-300"
                >
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h3 className="text-sm font-bold text-white mb-4 uppercase tracking-wider">Liens rapides</h3>
            <ul className="flex flex-col gap-2.5">
              {[
                { href: '/',          label: 'Accueil' },
                { href: '/courses',   label: 'Formations' },
                { href: '/about',     label: 'À Propos' },
                { href: '/contact',   label: 'Contact' },
                { href: '/login',     label: 'Connexion' },
                { href: '/signup',    label: "S'inscrire" },
              ].map(l => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-white/55 hover:text-white transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Services */}
          <div>
            <h3 className="text-sm font-bold text-white mb-4 uppercase tracking-wider">Nos Services</h3>
            <ul className="flex flex-col gap-2.5">
              {SERVICES_LINKS.map(s => (
                <li key={s}>
                  <Link href="/courses" className="text-sm text-white/55 hover:text-white transition-colors">
                    {s}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="text-sm font-bold text-white mb-4 uppercase tracking-wider">Contact</h3>
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3 text-sm text-white/60">
                <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-secondary" />
                <span>Dakar, Sénégal<br />& International</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-white/60">
                <Phone className="w-4 h-4 shrink-0 text-secondary" />
                <span>+(221) 77 576 0306</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-white/60">
                <Mail className="w-4 h-4 shrink-0 text-secondary" />
                <a href="mailto:bonjour@smileycx.com" className="hover:text-white transition-colors">
                  bonjour@smileycx.com
                </a>
              </div>
            </div>

            {/* Newsletter mini-form */}
            <div className="mt-6">
              <p className="text-xs text-white/50 mb-3">Newsletter — restez informé :</p>
              <form className="flex gap-2" onSubmit={e => e.preventDefault()}>
                <input
                  type="email"
                  placeholder="Votre email"
                  className="flex-1 px-3 py-2 text-sm rounded-cx bg-white/10 border border-white/15 text-white placeholder:text-white/40 focus:outline-none focus:border-white/40"
                />
                <button
                  type="submit"
                  className="px-3 py-2 text-sm font-semibold bg-secondary text-white rounded-cx hover:bg-secondary-dark transition-colors shrink-0"
                >
                  OK
                </button>
              </form>
            </div>
          </div>
        </div>

        <hr className="border-white/10 mt-12 mb-6" />
        <div className="flex flex-col sm:flex-row justify-between items-center gap-3 text-xs text-white/40">
          <p>© 2025 XP Client Consulting. Tous droits réservés.</p>
          <div className="flex gap-4">
            <Link href="/privacy"    className="hover:text-white/70 transition-colors">Confidentialité</Link>
            <Link href="/terms"      className="hover:text-white/70 transition-colors">CGU</Link>
            <Link href="/admin/login" className="hover:text-white/70 transition-colors">Admin</Link>
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
