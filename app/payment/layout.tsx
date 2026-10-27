import Header from '@/components/layout/Header'
import Footer from '@/components/layout/Footer'

/**
 * The payment callback routes live outside the `(public)` group because the
 * PayTech dashboard holds their exact paths — `/payment/success` and
 * `/payment/cancel` — and a route group would not change them but a different
 * segment would. They therefore need their own layout, or they would render
 * with no header and no footer under the bare root layout.
 *
 * Deliberately identical to `app/(public)/layout.tsx` so a learner returning
 * from the provider lands on the same chrome they left.
 */
export default function PaymentLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main className="pt-[72px]">{children}</main>
      <Footer />
    </>
  )
}
