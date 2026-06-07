'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Building2, Loader2, ArrowRight } from 'lucide-react'

function slugify(str: string) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48)
}

export default function OnboardingPage() {
  const router = useRouter()
  const supabase = createClient()

  const [step, setStep]       = useState<1 | 2>(1)
  const [name, setName]       = useState('')
  const [industry, setIndustry] = useState('')
  const [country, setCountry] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const slug = slugify(name)

  async function handleCreate() {
    if (!name.trim()) { setError('Organization name is required'); return }
    setError('')
    setLoading(true)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    // Create org
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .insert({ name: name.trim(), slug, industry: industry || null, country: country || null })
      .select()
      .single()

    if (orgErr) {
      setError(orgErr.message.includes('unique') ? 'This organization name is already taken. Try a different one.' : orgErr.message)
      setLoading(false)
      return
    }

    // Add user as org_admin
    await supabase.from('organization_memberships').insert({
      org_id: org.id,
      user_id: user.id,
      role: 'org_admin',
    })

    router.push(`/app/${org.slug}/dashboard`)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-[#4a6de5]/10 flex items-center justify-center mx-auto mb-4">
            <Building2 className="w-7 h-7 text-[#4a6de5]" />
          </div>
          <h1 className="text-2xl font-extrabold text-gray-900">Create your organization</h1>
          <p className="text-sm text-gray-400 mt-2">
            Your CX workspace for tracking feedback, journeys, and actions.
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-7">
          {error && (
            <div className="mb-5 px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-5">
            {/* Org name */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="org-name" className="text-sm font-semibold text-gray-700">
                Organization name <span className="text-red-500">*</span>
              </label>
              <input
                id="org-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Acme Corp CX Team"
                className="w-full px-3.5 py-3 rounded-xl border border-gray-200 text-gray-900 text-sm placeholder:text-gray-400 focus:outline-none focus:border-[#4a6de5] focus:ring-3 focus:ring-[#4a6de5]/15 transition-all"
              />
              {slug && (
                <p className="text-xs text-gray-400">
                  URL: <span className="font-mono text-gray-600">xpclientacademy.com/app/{slug}</span>
                </p>
              )}
            </div>

            {/* Industry */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="org-industry" className="text-sm font-semibold text-gray-700">Industry</label>
              <select
                id="org-industry"
                value={industry}
                onChange={e => setIndustry(e.target.value)}
                className="w-full px-3.5 py-3 rounded-xl border border-gray-200 text-gray-900 text-sm focus:outline-none focus:border-[#4a6de5] focus:ring-3 focus:ring-[#4a6de5]/15 transition-all"
              >
                <option value="">Select industry (optional)</option>
                <option value="banking">Banking &amp; Finance</option>
                <option value="telecom">Telecom</option>
                <option value="retail">Retail &amp; E-commerce</option>
                <option value="insurance">Insurance</option>
                <option value="healthcare">Healthcare</option>
                <option value="hospitality">Hospitality</option>
                <option value="transport">Transport &amp; Logistics</option>
                <option value="energy">Energy &amp; Utilities</option>
                <option value="government">Government &amp; Public Service</option>
                <option value="other">Other</option>
              </select>
            </div>

            {/* Country */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="org-country" className="text-sm font-semibold text-gray-700">Country</label>
              <select
                id="org-country"
                value={country}
                onChange={e => setCountry(e.target.value)}
                className="w-full px-3.5 py-3 rounded-xl border border-gray-200 text-gray-900 text-sm focus:outline-none focus:border-[#4a6de5] focus:ring-3 focus:ring-[#4a6de5]/15 transition-all"
              >
                <option value="">Select country (optional)</option>
                <option value="SN">Sénégal</option>
                <option value="CI">Côte d&#39;Ivoire</option>
                <option value="ML">Mali</option>
                <option value="BF">Burkina Faso</option>
                <option value="GN">Guinée</option>
                <option value="CM">Cameroun</option>
                <option value="GA">Gabon</option>
                <option value="TG">Togo</option>
                <option value="BJ">Bénin</option>
                <option value="MA">Maroc</option>
                <option value="DZ">Algérie</option>
                <option value="TN">Tunisie</option>
                <option value="FR">France</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
          </div>

          <button
            onClick={handleCreate}
            disabled={loading || !name.trim()}
            className="w-full mt-7 flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-[#4a6de5] text-white font-bold text-sm hover:bg-[#3a5dd5] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Creating workspace…</>
            ) : (
              <>Create workspace <ArrowRight className="w-4 h-4" /></>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
