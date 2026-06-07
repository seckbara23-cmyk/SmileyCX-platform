import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-light flex flex-col">
      {/* Minimal header */}
      <header className="bg-white border-b border-black/[0.06] py-4">
        <div className="cx-container flex justify-between items-center">
          <Link href="/" className="text-xl font-extrabold text-primary">
            XP<span className="text-secondary"> Client</span>{' '}
            <span className="text-sm font-semibold text-cx-gray">Academy</span>
          </Link>
          <Link href="/" className="text-sm text-cx-gray hover:text-dark transition-colors">
            ← Retour à l&apos;accueil
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        {children}
      </main>

      <footer className="py-4 text-center text-xs text-cx-gray">
        © 2025 XP Client Academy
      </footer>
    </div>
  )
}
