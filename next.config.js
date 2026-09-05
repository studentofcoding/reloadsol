/** @type {import('next').NextConfig} */
const { IMAGE_REMOTE_HOSTS: imageHosts, UNOPTIMIZED_IMAGE_HOSTS } = require('./src/config/image-hosts.js')
const optimizedImageHosts = imageHosts.filter(
  (hostname) => !UNOPTIMIZED_IMAGE_HOSTS.includes(hostname),
)

const nextConfig = {
  // ===== INSTANT NAVIGATIONS (Next 16.3) =====
  // cacheComponents: server-cached components/data can be included in the
  //   static shell and reused across client navigations.
  // partialPrefetching: prefetch one reusable App Shell per route (instead of
  //   per-link); <Link prefetch> opts into runtime prefetching of URL data.
  cacheComponents: true,
  partialPrefetching: true,

  // ===== CORE CONFIGURATION =====
  output: 'standalone',
  outputFileTracingRoot: require('path').join(__dirname),
  outputFileTracingExcludes: {
    '*': [
      '**/ml/venv/**',
      '**/venv/**',
      '**/.git/**',
      '**/ml/__pycache__/**',
    ],
  },
  outputFileTracingIncludes: {
    '/api/mcap-tracking/sim-track': [
      './node_modules/onnxruntime-node/bin/**/*',
      './node_modules/onnxruntime-common/**/*',
      './node_modules/bigint-buffer/**/*',
    ],
    '/api/ml/pattern/reload': [
      './node_modules/onnxruntime-node/bin/**/*',
      './node_modules/onnxruntime-common/**/*',
      './node_modules/bigint-buffer/**/*',
    ],
  },
  typescript: {
    ignoreBuildErrors: process.env.SKIP_BUILD_CHECKS === 'true',
  },
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@jup-ag/wallet-adapter'],
  serverExternalPackages: ['puppeteer', 'bigint-buffer', 'onnxruntime-node'],

  // Faster dev compiles: tree-shake heavy package entrypoints (Turbopack + webpack)
  experimental: {
    optimizePackageImports: [
      '@solana/web3.js',
      '@solana/spl-token',
      '@tanstack/react-query',
      'react-icons',
      'chart.js',
      'react-chartjs-2',
      'date-fns',
    ],
  },

  // ===== COMPRESSION & PERFORMANCE =====
  compress: true,

  // ===== TURBOPACK (Solana/crypto polyfills) =====
  turbopack: {
    root: __dirname,
    resolveAlias: {
      fs: { browser: './empty-module.js' },
      net: { browser: './empty-module.js' },
      tls: { browser: './empty-module.js' },
      crypto: { browser: './node_modules/crypto-browserify/index.js' },
      stream: { browser: './node_modules/stream-browserify/index.js' },
      url: { browser: './node_modules/url/url.js' },
      zlib: { browser: './node_modules/browserify-zlib/lib/index.js' },
      http: { browser: './node_modules/stream-http/index.js' },
      https: { browser: './node_modules/https-browserify/index.js' },
      assert: { browser: './node_modules/assert/build/assert.js' },
      os: { browser: './node_modules/os-browserify/browser.js' },
      path: { browser: './node_modules/path-browserify/index.js' },
      events: { browser: 'events' },
      'pino-pretty': { browser: './empty-module.js' },
      'bigint-buffer': { browser: './node_modules/bigint-buffer/dist/browser.js' },
    },
  },

  // ===== IMAGES OPTIMIZATION =====
  images: {
    formats: ['image/webp', 'image/avif'],
    minimumCacheTTL: 60 * 60 * 24 * 30, // 30 days
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: optimizedImageHosts.map((hostname) => ({
      protocol: 'https',
      hostname,
    })),
  },

  // ===== SECURITY HEADERS =====
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(), microphone=(), camera=()'
          },
          {
            key: 'Content-Security-Policy',
            value: `
              default-src 'self';
              script-src 'self' 'unsafe-eval' 'unsafe-inline' *.vercel-analytics.com *.jup.ag *.simpleanalyticscdn.com static.cloudflareinsights.com;
              style-src 'self' 'unsafe-inline' fonts.googleapis.com;
              font-src 'self' fonts.gstatic.com;
              img-src 'self' data: blob: https:;
              connect-src 'self' *.supabase.co *.supabase.in *.shyft.to *.solanatracker.io *.helius-rpc.com https://mainnet.helius-rpc.com *.solana.com *.jup.ag *.jupiter-swap.com cloudflareinsights.com *.cloudflareinsights.com wss: https:;
              frame-src 'self' https://auth.privy.io https://www.gmgn.cc https://gmgn.cc https://terminal.jup.ag/ https://plugin.jup.ag/;
              object-src 'none';
              base-uri 'self';
              form-action 'self';
            `.replace(/\s+/g, ' ').trim()
          }
        ]
      },
      {
        source: '/favicon.ico',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable'
          }
        ]
      },
      {
        source: '/_next/static/(.*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable'
          }
        ]
      }
    ]
  },

  // ===== COMPILER OPTIMIZATIONS =====
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? {
      exclude: ['error', 'warn']
    } : false,
    reactRemoveProperties: process.env.NODE_ENV === 'production',
  },

  // ===== WEBPACK OPTIMIZATIONS (fallback when using --webpack) =====
  webpack: (config, { dev, isServer }) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: require.resolve('crypto-browserify'),
      stream: require.resolve('stream-browserify'),
      url: require.resolve('url'),
      zlib: require.resolve('browserify-zlib'),
      http: require.resolve('stream-http'),
      https: require.resolve('https-browserify'),
      assert: require.resolve('assert'),
      os: require.resolve('os-browserify'),
      path: require.resolve('path-browserify'),
      events: require.resolve('events/'),
      'pino-pretty': false,
    }

    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        'bigint-buffer': require.resolve('bigint-buffer/dist/browser'),
      }
    }

    if (!dev) {
      config.module.rules.push({
        test: /tokenOperations\.ts$/,
        use: 'null-loader',
      })
    }

    if (!dev && !isServer) {
      config.optimization.splitChunks = {
        chunks: 'all',
        minSize: 20000,
        maxSize: 200000,
        maxInitialRequests: 6,
        maxAsyncRequests: 10,
        cacheGroups: {
          default: false,
          vendors: false,
          framework: {
            name: 'framework',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](react|react-dom|next)[\\/]/,
            priority: 50,
            enforce: true,
          },
          solana: {
            name: 'solana',
            chunks: 'async',
            test: /[\\/]node_modules[\\/](@solana|@metaplex)[\\/]/,
            priority: 45,
            enforce: true,
          },
          charts: {
            name: 'charts',
            chunks: 'async',
            test: /[\\/]node_modules[\\/](chart\.js|react-chartjs-2)[\\/]/,
            priority: 40,
            enforce: true,
          },
          reactQuery: {
            name: 'react-query',
            chunks: 'all',
            test: /[\\/]node_modules[\\/]@tanstack\/react-query/,
            priority: 38,
            enforce: true,
          },
          supabase: {
            name: 'supabase',
            chunks: 'all',
            test: /[\\/]node_modules[\\/]@supabase/,
            priority: 37,
            enforce: true,
          },
          crypto: {
            name: 'crypto',
            chunks: 'async',
            test: /[\\/]node_modules[\\/](crypto-browserify|stream-browserify|https-browserify|os-browserify|path-browserify|browserify-zlib|stream-http|assert)[\\/]/,
            priority: 35,
            enforce: true,
          },
          utils: {
            name: 'utils',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](axios|chalk|ora)[\\/]/,
            priority: 30,
            enforce: true,
          },
          vendor: {
            name: 'vendor',
            chunks: 'async',
            test: /[\\/]node_modules[\\/]/,
            priority: 20,
            minChunks: 2,
          },
          common: {
            name: 'common',
            chunks: 'all',
            minChunks: 2,
            priority: 10,
            reuseExistingChunk: true,
          },
        },
      }

      config.optimization.usedExports = true
      config.optimization.sideEffects = false
      config.optimization.concatenateModules = true
      config.optimization.minimize = true
    }

    if (!dev) {
      config.devtool = false
    }

    return config
  },

  // ===== ENVIRONMENT VARIABLES =====
  env: {
    NEXT_TELEMETRY_DISABLED: '1',
  },

  // ===== REDIRECTS & REWRITES =====
  async redirects() {
    return [
      {
        source: '/search-token',
        destination: '/dev/search-token',
        permanent: true,
      },
      {
        source: '/search-token/:path*',
        destination: '/dev/search-token/:path*',
        permanent: true,
      },
      {
        source: '/dev/token-search',
        destination: '/dev/search-token/detail',
        permanent: true,
      },
    ]
  },

  async rewrites() {
    return [
      {
        source: '/rpc/:path*',
        destination: '/api/rpc/:path*'
      }
    ]
  },

  // ===== BUNDLE ANALYSIS =====
  ...(process.env.ANALYZE === 'true' && {
    bundlePagesRouterDependencies: false,
  }),
}

if (process.env.ANALYZE === 'true') {
  const withBundleAnalyzer = require('@next/bundle-analyzer')({
    enabled: true,
  })
  module.exports = withBundleAnalyzer(nextConfig)
} else {
  module.exports = nextConfig
}
