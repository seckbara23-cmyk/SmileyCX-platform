

const nextConfig = {
  // Enables instrumentation.ts, which validates the external Supabase Auth
  // configuration at server startup (SEC-2 §2). Stable in Next 15; opt-in on 14.x.
  experimental: {
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },
}

export default nextConfig
