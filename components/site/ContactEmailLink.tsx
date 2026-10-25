import { CONTACT_EMAIL } from '@/lib/brand'

/**
 * The official contact address, rendered so it never wraps awkwardly.
 *
 * ── WHY THIS EXISTS (XP-BRAND-04A) ────────────────────────────────────────
 *
 * `contact@xpclient-academy.com` measures 227px in Montserrat 400 at 14px
 * (`text-sm`). In the "Nos coordonnées" card the text column is the sidebar
 * track minus the card padding (`p-6` = 48px) and the icon row (`w-4` +
 * `gap-3` = 28px), so a 280px track left only 204px — 23px short. The address
 * therefore wrapped, and CSS's only default break opportunity in it is the
 * hyphen, which produced the awkward `contact@xpclient-` / `academy.com`.
 *
 * Widening the track fixes the common widths, but a narrow phone (360px) or a
 * fallback font wider than Montserrat can still run out of room. So the break
 * point is also corrected here: a `<wbr>` after the `@` adds a zero-width
 * break opportunity, and the domain is held together with `whitespace-nowrap`
 * so the hyphen can no longer be chosen. The address then wraps as
 * `contact@` / `xpclient-academy.com`, whose widest line is just 159px.
 *
 * `<wbr>` inserts no character: the rendered text, selection and clipboard
 * copy all still yield the full address, and `href` always carries it intact.
 */
/**
 * Split an address into the part up to and including '@', and the domain.
 * Splits on the LAST '@' so a quoted local part containing one cannot break
 * it, and returns an empty domain for input with no '@' at all, which makes
 * the caller render the value verbatim rather than inventing a break point.
 */
export function splitEmailForWrap(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf('@')
  if (at === -1) return { local: email, domain: '' }
  return { local: email.slice(0, at + 1), domain: email.slice(at + 1) }
}

export default function ContactEmailLink({ className = '' }: { className?: string }) {
  const { local, domain } = splitEmailForWrap(CONTACT_EMAIL)

  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className={className}>
      {local}
      {domain && (
        <>
          <wbr />
          <span className="whitespace-nowrap">{domain}</span>
        </>
      )}
    </a>
  )
}
