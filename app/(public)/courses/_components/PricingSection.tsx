'use client'
import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Sparkles } from 'lucide-react'
import { PILOT_MODE } from '@/lib/pilot'
import { PRICING_PLANS, formatFcfa } from '../content'

type Billing = 'monthly' | 'annual'

const ANNUAL_DISCOUNT = 0.8 // -20 %

export default function PricingSection() {
  const [billing, setBilling] = useState<Billing>('monthly')

  return (
    <section className="py-14 md:py-16">
      <div className="cx-container">

        {/* Header row: heading left, billing toggle right */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-5 mb-4">
          <div>
            <p className="text-secondary text-xs font-bold uppercase tracking-widest mb-2">
              Tarifs par parcours
            </p>
            <h2 className="text-2xl md:text-3xl font-extrabold text-dark">
              Investissez dans votre mont&eacute;e en comp&eacute;tences
            </h2>
          </div>

          {/* Visual-only billing toggle */}
          <div className="flex items-center bg-light rounded-full p-1 self-start md:self-auto" role="group" aria-label="Période de facturation">
            <button
              type="button"
              onClick={() => setBilling('monthly')}
              aria-pressed={billing === 'monthly'}
              className={`px-4 py-1.5 text-xs font-bold rounded-full transition-colors ${
                billing === 'monthly' ? 'bg-dark text-white' : 'text-cx-gray hover:text-dark'
              }`}
            >
              Mensuel
            </button>
            <button
              type="button"
              onClick={() => setBilling('annual')}
              aria-pressed={billing === 'annual'}
              className={`px-4 py-1.5 text-xs font-bold rounded-full transition-colors ${
                billing === 'annual' ? 'bg-dark text-white' : 'text-cx-gray hover:text-dark'
              }`}
            >
              Annuel <span className="font-semibold">(&eacute;conomisez 20%)</span>
            </button>
          </div>
        </div>

        {/* Pilot free-access badge (display only — no business logic) */}
        {PILOT_MODE && (
          <div className="mb-8">
            <span className="inline-flex items-center gap-2 bg-success/10 text-success text-xs font-bold px-4 py-2 rounded-full">
              <Sparkles className="w-3.5 h-3.5" aria-hidden />
              Acc&egrave;s gratuit pendant la phase pilote
            </span>
          </div>
        )}

        {/* Plans */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {PRICING_PLANS.map((plan) => {
            const price =
              plan.monthlyPrice === null
                ? null
                : billing === 'monthly'
                  ? plan.monthlyPrice
                  : Math.round(plan.monthlyPrice * 12 * ANNUAL_DISCOUNT)

            return (
              <div
                key={plan.id}
                className={`relative bg-white rounded-2xl shadow-sm p-6 md:p-7 flex flex-col ${plan.cardClass}`}
              >
                {plan.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-white text-[11px] font-bold uppercase tracking-wide px-3.5 py-1 rounded-full shadow-sm whitespace-nowrap">
                    Populaire
                  </span>
                )}

                {/* Name + tagline */}
                <p className={`text-sm font-extrabold mb-0.5 ${plan.nameClass}`}>{plan.name}</p>
                <p className="text-xs text-cx-gray mb-5">{plan.tagline}</p>

                {/* Price */}
                <div className="mb-6">
                  {price === null ? (
                    <p className={`text-3xl font-extrabold leading-none ${plan.priceClass}`}>Sur devis</p>
                  ) : (
                    <p className="flex items-baseline gap-1.5 flex-wrap">
                      <span className={`text-3xl font-extrabold leading-none ${plan.priceClass}`}>
                        {formatFcfa(price)} FCFA
                      </span>
                      <span className="text-xs text-cx-gray font-medium">
                        {billing === 'monthly' ? '/mois accès' : '/an accès'}
                      </span>
                    </p>
                  )}
                </div>

                {/* Features */}
                <ul className="space-y-2.5 flex-1 mb-7">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-[13px] text-cx-gray leading-relaxed">
                      <CheckCircle2 className={`w-4 h-4 shrink-0 mt-0.5 ${plan.checkClass}`} aria-hidden />
                      {f}
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <Link
                  href={plan.ctaHref}
                  className={`inline-flex items-center justify-center w-full px-4 py-3 text-sm font-bold rounded-cx transition-all ${plan.ctaClass}`}
                >
                  {plan.ctaLabel}
                </Link>
              </div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
