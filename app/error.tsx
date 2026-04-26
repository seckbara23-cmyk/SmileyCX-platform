'use client'

import Link from 'next/link'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="max-w-md w-full text-center">
        <h1 className="text-2xl font-extrabold text-gray-900 mb-2">Une erreur est survenue</h1>
        <p className="text-sm text-gray-500 mb-6">
          Quelque chose s&apos;est mal passé. Veuillez réessayer ou retourner à l&apos;accueil.
          {error.digest && (
            <span className="block mt-1 font-mono text-xs text-gray-400">Ref: {error.digest}</span>
          )}
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="px-6 py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:opacity-90 transition-opacity"
          >
            Réessayer
          </button>
          <Link
            href="/"
            className="px-6 py-2.5 text-sm font-semibold text-gray-600 hover:text-gray-900 transition-colors"
          >
            Accueil
          </Link>
        </div>
      </div>
    </div>
  )
}
