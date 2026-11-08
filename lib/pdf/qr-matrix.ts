import QRCodeImpl from 'qr.js/lib/QRCode'
import ErrorCorrectLevel from 'qr.js/lib/ErrorCorrectLevel'

/**
 * The QR module matrix of a value — XP-LAUNCH-FINAL-02.
 *
 * The on-screen certificate draws its verification QR with `react-qr-code`,
 * which is a thin React wrapper around `qr.js`. The PDF cannot use a DOM
 * component, so this reuses the same encoder and hands the PDF document the
 * raw modules to draw as rectangles. Same library, same error-correction
 * level, so the printed code and the on-screen code are the same code.
 */
export type QrLevel = 'L' | 'M' | 'Q' | 'H'

export function qrModules(value: string, level: QrLevel = 'M'): boolean[][] {
  const qr = new QRCodeImpl(-1, ErrorCorrectLevel[level])
  qr.addData(value)
  qr.make()
  const modules = qr.modules
  if (!modules || modules.length === 0) throw new Error('qr.js produced no modules')
  return modules.map(row => row.map(Boolean))
}
