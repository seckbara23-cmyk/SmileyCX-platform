import type { ReactNode } from 'react'
import Link from 'next/link'
import type { LegalBlock, LegalText } from '@/lib/legal/documents'
import { LEGAL_TEXT_PENDING_REVIEW } from '@/lib/legal/versions'

/**
 * Renders one of the four legal texts of ./lib/legal/documents — XP-LAUNCH-FINAL-11.
 *
 * The text is data; this only lays it out. Inline **bold** and *italic* are the
 * only markup, and e-mail addresses become mailto links. While the lawyer's
 * review is pending the page says so factually, without claiming an approval
 * that has not happened.
 */

const EMAIL_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g

function linkEmails(text: string, keyPrefix: string): ReactNode[] {
  return text.split(EMAIL_RE).map((part, i) =>
    i % 2 === 1
      ? <a key={`${keyPrefix}-m${i}`} href={`mailto:${part}`} className="text-primary underline">{part}</a>
      : part,
  )
}

/** **bold** and *italic*, nothing else. */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(...linkEmails(text.slice(last, m.index), `${key}-t${n}`))
    if (m[1] !== undefined) out.push(<strong key={`${key}-b${n}`} className="text-dark">{linkEmails(m[1], `${key}-bb${n}`)}</strong>)
    else out.push(<em key={`${key}-e${n}`}>{linkEmails(m[2], `${key}-ee${n}`)}</em>)
    last = re.lastIndex
    n++
  }
  if (last < text.length) out.push(...linkEmails(text.slice(last), `${key}-t${n}`))
  return out
}

function Block({ block, k }: { block: LegalBlock; k: string }) {
  if ('p' in block) return <p className="leading-relaxed">{inline(block.p, k)}</p>
  if ('h3' in block) return <h3 className="font-semibold text-dark mt-4">{block.h3}</h3>
  if ('ul' in block) {
    return <ul className="list-disc pl-6 space-y-1">{block.ul.map((t, i) => <li key={i}>{inline(t, `${k}-${i}`)}</li>)}</ul>
  }
  if ('ol' in block) {
    return <ol className="list-decimal pl-6 space-y-1">{block.ol.map((t, i) => <li key={i}>{inline(t, `${k}-${i}`)}</li>)}</ol>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse text-sm">
        <thead>
          <tr>{block.table.head.map((h, i) => <th key={i} className="border-b border-cx-gray/30 py-2 pr-4 font-semibold text-dark">{h}</th>)}</tr>
        </thead>
        <tbody>
          {block.table.rows.map((row, r) => (
            <tr key={r}>{row.map((cell, c) => <td key={c} className="border-b border-cx-gray/10 py-2 pr-4 align-top">{inline(cell, `${k}-${r}-${c}`)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The other legal pages, linked at the foot of each one. */
export const LEGAL_PAGES = [
  { href: '/terms', label: 'Conditions générales d’utilisation' },
  { href: '/cgv', label: 'Conditions générales de vente' },
  { href: '/privacy', label: 'Politique de confidentialité' },
  { href: '/mentions-legales', label: 'Mentions légales' },
] as const

export default function LegalDocumentView({ doc, href }: { doc: LegalText; href: string }) {
  return (
    <section className="cx-section">
      <div className="cx-container max-w-4xl text-dark">
        <article className="cx-card p-8">
          <h1 className="text-3xl font-extrabold mb-2">{doc.title}</h1>
          <p className="text-sm text-cx-gray mb-4">Version {doc.version} — {doc.dated}</p>

          {LEGAL_TEXT_PENDING_REVIEW && (
            <div role="note" className="mb-6 px-4 py-3 rounded-cx bg-amber-50 border border-amber-200 text-sm text-amber-900">
              Une relecture juridique de ce texte est en cours. Toute modification sera publiée sous un
              nouveau numéro de version ; les achats déjà faits restent soumis aux conditions de vente en
              vigueur au moment de l’achat.
            </div>
          )}

          <div className="space-y-4 text-sm text-cx-gray">
            {doc.intro.map((b, i) => <Block key={`intro-${i}`} block={b} k={`intro-${i}`} />)}
            {doc.sections.map(s => (
              <section key={s.id} id={s.id} className="space-y-3 pt-2">
                <h2 className="text-lg font-bold text-dark">{s.title}</h2>
                {s.blocks.map((b, i) => <Block key={`${s.id}-${i}`} block={b} k={`${s.id}-${i}`} />)}
              </section>
            ))}
          </div>

          <nav aria-label="Documents juridiques" className="mt-8 pt-4 border-t border-cx-gray/20 text-sm flex flex-wrap gap-x-6 gap-y-2">
            {LEGAL_PAGES.filter(p => p.href !== href).map(p => (
              <Link key={p.href} href={p.href} className="text-primary hover:underline">{p.label}</Link>
            ))}
          </nav>
        </article>
      </div>
    </section>
  )
}
