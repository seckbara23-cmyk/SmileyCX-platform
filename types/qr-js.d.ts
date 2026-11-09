/**
 * Types for the two `qr.js` modules `react-qr-code` already ships with (a
 * transitive dependency of this project, CommonJS, untyped). Only what
 * `lib/pdf/qr-matrix.ts` uses is declared.
 */
declare module 'qr.js/lib/QRCode' {
  export default class QRCode {
    /** `typeNumber` -1 lets the library pick the smallest version that fits. */
    constructor(_typeNumber: number, _errorCorrectLevel: number)
    addData(_data: string): void
    make(): void
    /** Filled by `make()`: `modules[row][col]` is true for a dark module. */
    modules: boolean[][] | null
    getModuleCount(): number
    isDark(_row: number, _col: number): boolean
  }
}

declare module 'qr.js/lib/ErrorCorrectLevel' {
  const ErrorCorrectLevel: { readonly L: number; readonly M: number; readonly Q: number; readonly H: number }
  export default ErrorCorrectLevel
}
