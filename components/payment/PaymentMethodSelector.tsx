'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Shield } from 'lucide-react'
import { createPaymentRecord } from '@/app/actions/payment'
import { PAYMENTS_ENABLED } from '@/lib/pilot'
import { Input } from '@/components/ui/Input'
import type { PaymentMethod, Course, Profile } from '@/types'

interface Props {
  course: Course
  profile: Profile
}

const METHODS: { id: PaymentMethod; label: string; icon: string; color: string; hint: string }[] = [
  {
    id:    'orange_money',
    label: 'Orange Money',
    icon:  '🟠',
    color: 'border-orange-400 bg-orange-50',
    hint:  'Numéro Orange Money (ex: 77 XXX XX XX)',
  },
  {
    id:    'wave',
    label: 'Wave',
    icon:  '🔵',
    color: 'border-blue-500 bg-blue-50',
    hint:  'Numéro Wave (ex: 77 XXX XX XX)',
  },
  {
    id:    'card',
    label: 'Carte Bancaire',
    icon:  '💳',
    color: 'border-gray-400 bg-gray-50',
    hint:  'Visa, Mastercard, etc.',
  },
]

export default function PaymentMethodSelector({ course, profile: _profile }: Props) {
  const router = useRouter()

  const [method,  setMethod]  = useState<PaymentMethod | null>(null)
  const [phone,   setPhone]   = useState('')
  const [card,    setCard]    = useState({ number: '', expiry: '', cvv: '', name: '' })
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  // Hard guard — the checkout page already blocks this component when payments
  // are disabled, but we add a second check here for defence in depth.
  if (!PAYMENTS_ENABLED) {
    return (
      <p className="text-sm text-cx-gray italic">
        Le paiement n&apos;est pas disponible pendant la phase pilote.
      </p>
    )
  }

  async function handlePay() {
    if (!method) { setError('Sélectionnez un mode de paiement'); return }
    if ((method === 'orange_money' || method === 'wave') && !phone.trim()) {
      setError('Entrez votre numéro de téléphone')
      return
    }
    if (method === 'card' && (!card.number || !card.expiry || !card.cvv || !card.name)) {
      setError('Veuillez remplir tous les champs de la carte')
      return
    }
    setError('')
    setLoading(true)

    const metadata: Record<string, string> = method === 'card'
      ? { cardholder: card.name }   // never store raw card data
      : { phone }

    // Payment record is created server-side — amount is read from the DB,
    // not from the client, so the price cannot be tampered with.
    const result = await createPaymentRecord({
      courseId: course.id,
      method,
      metadata,
    })

    if (result.error) {
      setError(result.error)
      setLoading(false)
      return
    }

    router.push(`/checkout/confirm?payment=${result.paymentId}`)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Method selection */}
      <div>
        <p className="text-sm font-semibold text-dark mb-3">Mode de paiement</p>
        <div className="flex flex-col gap-3">
          {METHODS.map(m => (
            <label
              key={m.id}
              className={`flex items-center gap-4 p-4 rounded-cx border-2 cursor-pointer transition-all ${
                method === m.id ? m.color + ' border-opacity-100' : 'border-[#dde2f0] hover:border-primary/40 bg-white'
              }`}
            >
              <input
                type="radio"
                name="payment_method"
                value={m.id}
                checked={method === m.id}
                onChange={() => { setMethod(m.id); setError('') }}
                className="sr-only"
              />
              <span className="text-2xl">{m.icon}</span>
              <div className="flex-1">
                <p className="font-semibold text-dark text-sm">{m.label}</p>
                <p className="text-xs text-cx-gray">{m.hint}</p>
              </div>
              {method === m.id && (
                <Check className="w-5 h-5 text-primary shrink-0" />
              )}
            </label>
          ))}
        </div>
      </div>

      {/* Dynamic fields */}
      {(method === 'orange_money' || method === 'wave') && (
        <Input
          label={`Numéro ${method === 'orange_money' ? 'Orange Money' : 'Wave'}`}
          type="tel"
          placeholder="77 XXX XX XX"
          value={phone}
          onChange={e => setPhone(e.target.value)}
          hint="Un message de confirmation vous sera envoyé"
          required
        />
      )}

      {method === 'card' && (
        <div className="flex flex-col gap-4 p-4 bg-light rounded-cx border border-[#dde2f0]">
          <Input
            label="Nom sur la carte"
            type="text"
            placeholder="PRÉNOM NOM"
            value={card.name}
            onChange={e => setCard(c => ({ ...c, name: e.target.value }))}
            required
          />
          <Input
            label="Numéro de carte"
            type="text"
            placeholder="1234 5678 9012 3456"
            value={card.number}
            onChange={e => setCard(c => ({ ...c, number: e.target.value }))}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Expiration"
              type="text"
              placeholder="MM/AA"
              value={card.expiry}
              onChange={e => setCard(c => ({ ...c, expiry: e.target.value }))}
              required
            />
            <Input
              label="CVV"
              type="text"
              placeholder="123"
              value={card.cvv}
              onChange={e => setCard(c => ({ ...c, cvv: e.target.value }))}
              required
            />
          </div>
          <p className="text-xs text-cx-gray flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-success" />
            Vos données de carte sont sécurisées et chiffrées
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm text-error font-medium">{error}</p>
      )}

      {/* Pay button */}
      <button
        onClick={handlePay}
        disabled={loading || !method}
        className={`w-full flex items-center justify-center gap-2 py-4 rounded-cx font-bold text-white text-base transition-all ${
          loading || !method
            ? 'bg-cx-gray/40 cursor-not-allowed'
            : 'bg-secondary hover:bg-secondary-dark hover:-translate-y-0.5 shadow-btn'
        }`}
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Traitement en cours…
          </>
        ) : (
          `Payer`
        )}
      </button>

      <p className="text-xs text-center text-cx-gray">
        🔒 Paiement sécurisé · Accès immédiat après confirmation
      </p>
    </div>
  )
}
