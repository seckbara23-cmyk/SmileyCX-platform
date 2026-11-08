// @vitest-environment node
/**
 * XP-LAUNCH-FINAL-02 — the certificate's verification QR, on screen and in the PDF.
 *
 * The on-screen certificate already drew a QR code of the public verification
 * URL with `react-qr-code`. The downloadable PDF printed that URL as text only,
 * so a printed certificate could not be scanned. The PDF now draws the same
 * code, from the same encoder (`qr.js`, the library `react-qr-code` wraps), as
 * rectangles in the PDF renderer's own SVG primitives. No new dependency.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import QRCode from 'react-qr-code'
import { renderToBuffer } from '@react-pdf/renderer'
import { qrModules } from '@/lib/pdf/qr-matrix'
import { CertificatePDFDocument } from '@/lib/pdf/CertificatePDF'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

const VERIFY_URL = 'https://www.xpclient-academy.com/verify-certificate/0f1e2d3c-4b5a-4968-8777-66554433aabb'

/** The three 7×7 finder patterns every QR symbol carries, read from a module matrix. */
function finderAt(m: boolean[][], top: number, left: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const edge = r === 0 || r === 6 || c === 0 || c === 6
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
      const expected = edge || core
      if (m[top + r][left + c] !== expected) return false
    }
  }
  return true
}

/** The dark cells of the on-screen component, read from the SVG it renders: one `M col row` move per dark cell. */
function darkCellsOnScreen(url: string): { size: number; cells: Set<string> } {
  const svg = renderToStaticMarkup(createElement(QRCode, { value: url, level: 'M', size: 256 }))
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1])
  const cells = new Set<string>()
  for (const tag of svg.match(/<path\b[^>]*>/g) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
    if (attrs.fill !== '#000000') continue   // the foreground path carries the dark cells
    for (const m of attrs.d.matchAll(/M (\d+) (\d+)/g)) cells.add(`${m[2]}:${m[1]}`)
  }
  return { size, cells }
}

function darkCellsInPdf(url: string): { size: number; cells: Set<string> } {
  const m = qrModules(url)
  const cells = new Set<string>()
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) cells.add(`${r}:${c}`) }))
  return { size: m.length, cells }
}

describe('XP-LAUNCH-FINAL-02 · the QR module matrix', () => {
  it('is a square QR symbol of a valid version, with its three finder patterns', () => {
    const m = qrModules(VERIFY_URL)
    const n = m.length
    expect(n).toBeGreaterThanOrEqual(21)
    expect((n - 17) % 4).toBe(0)
    for (const row of m) expect(row).toHaveLength(n)
    expect(finderAt(m, 0, 0)).toBe(true)
    expect(finderAt(m, 0, n - 7)).toBe(true)
    expect(finderAt(m, n - 7, 0)).toBe(true)
    // The timing pattern alternates between the finders on row 6.
    for (let c = 8; c < n - 8; c++) expect(m[6][c]).toBe(c % 2 === 0)
  })

  it('is deterministic for the same value and different for another certificate', () => {
    expect(qrModules(VERIFY_URL)).toEqual(qrModules(VERIFY_URL))
    const other = qrModules(VERIFY_URL.replace(/aabb$/, 'aabc'))
    expect(other).not.toEqual(qrModules(VERIFY_URL))
  })

  it('is the SAME code the on-screen certificate draws: every dark cell, cell for cell', () => {
    const screen = darkCellsOnScreen(VERIFY_URL)
    const pdf = darkCellsInPdf(VERIFY_URL)
    expect(screen.size).toBeGreaterThanOrEqual(21)
    expect(pdf.size).toBe(screen.size)
    expect(pdf.cells.size).toBeGreaterThan(screen.size * 4)
    expect(pdf.cells).toEqual(screen.cells)
    // And a different certificate gives a different code on both sides alike.
    const otherUrl = VERIFY_URL.replace(/aabb$/, 'aabc')
    expect(darkCellsInPdf(otherUrl).cells).toEqual(darkCellsOnScreen(otherUrl).cells)
    expect(darkCellsInPdf(otherUrl).cells).not.toEqual(pdf.cells)
  })

  it('reuses the encoder of the on-screen QR, with the same error-correction level', () => {
    const matrix = read('lib/pdf/qr-matrix.ts')
    expect(matrix).toMatch(/from 'qr\.js\/lib\/QRCode'/)
    expect(matrix).toMatch(/from 'qr\.js\/lib\/ErrorCorrectLevel'/)
    const view = read('app/(platform)/certificates/[certificateId]/CertificateView.tsx')
    expect(view).toMatch(/from 'react-qr-code'/)
    expect(view).toMatch(/<QRCode value=\{verifyUrl\} size=\{\d+\} level="M"/)
    expect(code('lib/pdf/qr-matrix.ts')).toMatch(/level: QrLevel = 'M'/)
    expect(JSON.parse(read('package.json')).dependencies['react-qr-code']).toBeTruthy()
  })
})

describe('XP-LAUNCH-FINAL-02 · the certificate PDF carries the QR of its verification URL', () => {
  it('draws the modules with the PDF renderer\'s SVG primitives, only when a verification URL is given', () => {
    const pdf = code('lib/pdf/CertificatePDF.tsx')
    expect(pdf).toMatch(/import \{[^}]*\bSvg\b[^}]*\} from '@react-pdf\/renderer'/)
    expect(pdf).toMatch(/\bRect\b/)
    expect(pdf).toMatch(/qrModules\(value, 'M'\)/)
    expect(pdf).toMatch(/<QrSvg value=\{verifyUrl\} \/>/)
    // The URL stays printed in clear beside the code, for a reader without a scanner.
    expect(pdf).toMatch(/Vérifier l&apos;authenticité : \{verifyUrl\}/)
  })

  it('the PDF route hands the document the canonical verification URL', () => {
    const route = code('app/api/certificates/[id]/pdf/route.ts')
    expect(route).toMatch(/verifyUrl:\s*certificateVerifyUrl\(/)
    expect(code('lib/brand.ts')).toMatch(/\/verify-certificate\/\$\{certificateId\}/)
  })

  it('renders to a PDF with the QR and is larger than the same certificate without one', async () => {
    const props = {
      learnerName: 'Apprenante Test', courseTitle: 'Les fondamentaux de l’expérience client',
      certNumber: 'XPC-2026-123456', issuedAt: '2026-11-08T12:00:00.000Z',
    }
    const withQr = await renderToBuffer(createElement(CertificatePDFDocument, { ...props, verifyUrl: VERIFY_URL }) as never)
    const withoutQr = await renderToBuffer(createElement(CertificatePDFDocument, props) as never)
    expect(withQr.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(withoutQr.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(withQr.length).toBeGreaterThan(withoutQr.length)
  }, 60_000)
})
