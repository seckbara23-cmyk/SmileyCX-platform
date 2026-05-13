'use client'
import { useEffect, useState, useRef } from 'react'
import { CheckCircle, ChevronRight, X } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface Props {
  nextHref:      string
  nextLabel:     string
  delaySeconds?: number
  onCancel:      () => void
}

export default function AutoAdvanceBanner({
  nextHref, nextLabel, delaySeconds = 5, onCancel,
}: Props) {
  const router        = useRouter()
  const [countdown,   setCountdown]   = useState(delaySeconds)
  const navigatedRef  = useRef(false)

  useEffect(() => {
    navigatedRef.current = false
    setCountdown(delaySeconds)

    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(id)
          if (!navigatedRef.current) {
            navigatedRef.current = true
            router.push(nextHref)
          }
          return 0
        }
        return c - 1
      })
    }, 1000)

    return () => clearInterval(id)
  }, [nextHref, delaySeconds, router])

  function skipNow() {
    navigatedRef.current = true
    router.push(nextHref)
  }

  const fillPct = ((delaySeconds - countdown) / delaySeconds) * 100

  return (
    <div className="relative overflow-hidden rounded-xl bg-success/[0.08] border border-success/25 p-4">
      {/* Animated progress bar along the bottom */}
      <div
        className="absolute bottom-0 left-0 h-[3px] bg-success/50 rounded-b-xl transition-[width] duration-1000 ease-linear"
        style={{ width: `${fillPct}%` }}
      />

      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="w-9 h-9 rounded-full bg-success/15 border border-success/25 flex items-center justify-center shrink-0 mt-0.5">
          <CheckCircle className="w-5 h-5 text-success" />
        </div>

        {/* Text + actions */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-success leading-tight">Leçon terminée ✓</p>
          <p className="text-xs text-white/50 mt-1">
            {nextLabel} dans&nbsp;
            <span className="font-bold text-white/75 tabular-nums">
              {countdown}
            </span>
            &nbsp;seconde{countdown !== 1 ? 's' : ''}…
          </p>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button
              onClick={skipNow}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-success text-white text-xs font-bold rounded-lg hover:opacity-90 active:scale-[0.98] transition-all"
            >
              Passer maintenant <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onCancel}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.07] text-white/50 text-xs font-medium rounded-lg hover:bg-white/[0.12] hover:text-white/70 active:scale-[0.98] transition-all"
            >
              <X className="w-3.5 h-3.5" /> Annuler
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
