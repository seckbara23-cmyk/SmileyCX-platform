'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { Search } from 'lucide-react'

export default function UserSearchBar({ defaultValue = '' }: { defaultValue?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, start] = useTransition()

  return (
    <div className="relative w-full max-w-sm">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
      <input
        type="text"
        placeholder="Rechercher par nom ou email…"
        defaultValue={defaultValue}
        onChange={e => {
          const params = new URLSearchParams(searchParams.toString())
          if (e.target.value) params.set('q', e.target.value)
          else params.delete('q')
          start(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }))
        }}
        className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
      />
    </div>
  )
}
