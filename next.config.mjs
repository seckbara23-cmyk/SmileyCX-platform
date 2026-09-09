

const nextConfig = {
  // instrumentation.ts validates the external Supabase Auth configuration at
  // server startup (SEC-2 §2). It is loaded by default from Next 15 onward, so
  // the former experimental.instrumentationHook opt-in is gone — Next 15 rejects
  // the key outright. The instrumentation itself is unchanged and still runs.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },
}

export default nextConfig
