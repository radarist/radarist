import type { NextConfig } from 'next';

const useNormalProductionServer =
  process.env.E2E_BUILD === 'true' ||
  process.env.RADARIST_LOCAL_PRODUCTION_BUILD === 'true';

const nextConfig: NextConfig = {
  // Inngest sends originate from a few client-safe mutation services. Expose
  // only the boolean operator kill switch so INNGEST_ENABLED=false applies to
  // browser and server SDK instances without exposing keys or signing config.
  env: {
    NEXT_PUBLIC_INNGEST_ENABLED:
      process.env.NEXT_PUBLIC_INNGEST_ENABLED === 'false' || process.env.INNGEST_ENABLED === 'false'
        ? 'false'
        : '',
  },
  // `standalone` is the deployment artifact, but `next start` cannot serve it
  // (it warns and ships a half-hydrated app). E2E and the durable local
  // production launcher both build + serve through `next start`, so they opt
  // into the normal production-server artifact explicitly.
  output: useNormalProductionServer ? undefined : 'standalone',
  // `next dev` binds to `localhost`, so Next 16 treats requests from
  // `127.0.0.1` as cross-origin and blocks dev resources (HMR + client
  // chunks) by default — which leaves the app stuck on loading skeletons
  // when opened at the URL our docs/`demo:full` advertise
  // (`http://127.0.0.1:9002`). Allow it explicitly so the documented URL works.
  allowedDevOrigins: ['127.0.0.1'],
  /* config options here */
  serverExternalPackages: [
    'google-trends-api',
    'google-search-results-nodejs',
    'inngest',
    '@google/genai',
    '@anthropic-ai/sdk',
    'neo4j-driver',
    'firebase-admin',
    'pdf-parse',
    'cheerio',
  ],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
    ],
  },
  async headers() {
    // Real Content-Security-Policy response header for the PUBLIC share-report
    // route. The report body itself runs in a sandboxed iframe (see
    // share/report/[id]/share-iframe.ts); this header hardens the parent page:
    // no plugins, no clickjacking, and no report-controlled content in the
    // top-level document. `script-src`/`style-src` keep 'unsafe-inline' because
    // Next's App Router bootstraps with inline scripts and the page has no
    // nonce pipeline — but the parent page carries no untrusted HTML anymore
    // (the report is isolated in the iframe), so inline is not a report vector.
    const shareCsp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data:",
      "font-src 'self' data:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    return [
      {
        source: '/share/report/:id*',
        headers: [
          { key: 'Content-Security-Policy', value: shareCsp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/', destination: '/dashboard', permanent: true },
      { source: '/signals', destination: '/triage/signals', permanent: true },
      { source: '/library/signals', destination: '/triage/signals', permanent: true },
      { source: '/agents', destination: '/agents/runs', permanent: true },
      { source: '/triage', destination: '/triage/signals', permanent: true },
      { source: '/visualizations', destination: '/visualizations/radar', permanent: true },
    ];
  },
};

export default nextConfig;
