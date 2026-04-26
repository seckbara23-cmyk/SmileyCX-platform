'use client'

export default function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="px-4 py-2 text-sm font-semibold bg-light text-dark rounded-cx hover:bg-light/80 transition-colors border border-black/[0.08]"
    >
      🖨️ Imprimer
    </button>
  )
}
