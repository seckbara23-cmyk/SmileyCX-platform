'use client'

import Link from 'next/link'

export default function PlatformError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-8">
      <div className="max-w-sm w-full text-center">
        <h2 className="text-xl font-bold text-gray-900 mb-2">Quelque chose s&apos;est mal passé</h2>
        <p className="text-sm text-gray-500 mb-6">
          Impossible de charger cette page.
          {error.digest && (
            <span className="block mt-1 font-mono text-xs text-gray-400">Ref: {error.digest}</span>
          )}
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="px-5 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:opacity-90 transition-opacity"
          >
            Réessayer
          </button>
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
            Mon espace
          </Link>
        </div>
      </div>
    </div>
  )
}
