import { BENEFITS } from '../content'

export default function BenefitsStrip() {
  return (
    <section className="py-10 md:py-12 bg-light border-t border-black/[0.06]">
      <div className="cx-container">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {BENEFITS.map(({ Icon, title, desc }) => (
            <div key={title} className="flex items-start gap-3.5">
              <span className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Icon className="w-5 h-5 text-primary" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-bold text-dark mb-0.5">{title}</p>
                <p className="text-xs text-cx-gray leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
