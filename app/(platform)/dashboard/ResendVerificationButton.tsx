'use client'
import { useState } from 'react'
import { resendVerification } from '@/app/actions/auth'

/**
 * Resend the verification email from the dashboard banner (XPA-6A).
 *
 * The address is passed in from the server-rendered profile rather than typed,
 * so this cannot be used to probe other addresses. Rate limiting still applies
 * server-side, and the response is the same neutral message either way.
 */
export default function ResendVerificationButton({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')

  if (state === 'sent') {
    return (
      <p className="text-xs text-success font-semibold">
        Email de confirmation renvoyé. Pensez à vérifier vos spams.
      </p>
    )
  }

  return (
    <button
      type="button"
      disabled={state === 'sending'}
      onClick={async () => {
        setState('sending')
        await resendVerification({ email })
        setState('sent')
      }}
      className="text-xs font-bold text-primary hover:underline disabled:opacity-50"
    >
      {state === 'sending' ? 'Envoi…' : "Renvoyer l'email de confirmation"}
    </button>
  )
}
