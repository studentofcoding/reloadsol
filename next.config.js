/** @type {import('next').NextConfig} */
const nextConfig = {
  // ===== CORE CONFIGURATION =====
  reactStrictMode: true,
  swcMinify: true,
  poweredByHeader: false,

  // ===== COMPRESSION & PERFORMANCE =====
  compress: true,

  // ===== IMAGES OPTIMIZATION =====
  images: {
    formats: ['image/webp', 'image/avif'],
    minimumCacheTTL: 60 * 60 * 24 * 30, // 30 days
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    domains: [
      'raw.githubusercontent.com',
      'github.com',
      'assets.coingecko.com',
      'coin-images.coingecko.com',
      'cryptologos.cc',
      'tokens.1inch.io',
      'jupiter-aggregator.vercel.app',
      's3.coinmarketcap.com',
      'pbs.twimg.com',
      'ipfs.io',
      'arweave.net',
      'cdn.jsdelivr.net',
      'i.degencdn.com',
      'static-create.jup.ag',
      'proxy.duckduckgo.com',
      'ipfs.filebase.io',
      'image-cdn.solana.fm',
      'cf-ipfs.com',
      'kuji44lsf4frvko7srm7jdj6nqy2jzvdl5hy5dsodi7nva75rbtq.arweave.net'
    ],
  },

  // ===== SECURITY HEADERS =====
  async headers() {
    // Define allowed origins based on environment
    const getAllowedOrigins = () => {
      const baseOrigins = [
        'https://v2.reloadsol.xyz',      // Production
        'https://testing.reloadsol.xyz', // Testing/Staging
      ];

      // Add development origins in non-production
      if (process.env.NODE_ENV !== 'production') {
        baseOrigins.push(
          'http://localhost:3000',
          'http://localhost:3001',
          'http://127.0.0.1:3000',
          'http://127.0.0.1:3001',
          'http://localhost:4000',
          'http://localhost:4001',
          'http://127.0.0.1:4000',
          'http://127.0.0.1:4001',
        );
      }

      return baseOrigins;
    };

    const allowedOrigins = getAllowedOrigins();

    return [
      {
        source: '/(.*)',
        headers: [
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
              script-src 'self' 'unsafe-eval' 'unsafe-inline' *.vercel-analytics.com *.jup.ag *.simpleanalyticscdn.com https://challenges.cloudflare.com;
              style-src 'self' 'unsafe-inline' fonts.googleapis.com;
              font-src 'self' fonts.gstatic.com;
              img-src 'self' data: blob: https:;
              connect-src 'self' *.supabase.co *.supabase.in *.shyft.to *.helius-rpc.com *.solana.com *.jup.ag *.jupiter-swap.com https://auth.privy.io/ wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com wss: https:;
              frame-src 'self' https://auth.privy.io/ https://www.gmgn.cc https://gmgn.cc https://terminal.jup.ag/ https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com;
              object-src 'none';
              base-uri 'self';
              form-action 'self';
              frame-ancestors 'none';
              child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org;
              worker-src 'self';
              manifest-src 'self';
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

  // ===== WEBPACK OPTIMIZATIONS =====
  webpack: (config, { dev, isServer, webpack }) => {
    // Polyfills for Solana and crypto libraries
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
      'pino-pretty': false,
    }

    // Exclude development files from production builds
    if (!dev) {
      config.module.rules.push({
        test: /tokenOperations\.ts$/,
        use: 'null-loader',
      })
    }

    // Production optimizations - FIXED: More conservative bundle splitting
    if (!dev && !isServer) {
      config.optimization.splitChunks = {
        chunks: 'all',
        minSize: 20000,
        maxSize: 200000, // Reduced from 244000
        maxInitialRequests: 6, // Limit initial chunks
        maxAsyncRequests: 10,
        cacheGroups: {
          default: false,
          vendors: false,

          // ESSENTIAL: Only framework in initial bundle
          framework: {
            name: 'framework',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](react|react-dom|next)[\\/]/,
            priority: 50,
            enforce: true,
          },

          // ASYNC: Load Solana libraries on-demand only
          solana: {
            name: 'solana',
            chunks: 'async', // Changed from 'all' to 'async'
            test: /[\\/]node_modules[\\/](@solana|@metaplex)[\\/]/,
            priority: 45,
            enforce: true,
          },

          // ASYNC: Charts load when needed
          charts: {
            name: 'charts',
            chunks: 'async', // Changed from 'all' to 'async'
            test: /[\\/]node_modules[\\/](chart\.js|react-chartjs-2)[\\/]/,
            priority: 40,
            enforce: true,
          },

          // ESSENTIAL: Keep React Query in initial (used everywhere)
          reactQuery: {
            name: 'react-query',
            chunks: 'all',
            test: /[\\/]node_modules[\\/]@tanstack\/react-query/,
            priority: 38,
            enforce: true,
          },

          // ESSENTIAL: Keep Supabase in initial (used for auth/data)
          supabase: {
            name: 'supabase',
            chunks: 'all',
            test: /[\\/]node_modules[\\/]@supabase/,
            priority: 37,
            enforce: true,
          },

          // ASYNC: Crypto polyfills load when wallet connects
          crypto: {
            name: 'crypto',
            chunks: 'async', // Changed from 'all' to 'async'
            test: /[\\/]node_modules[\\/](crypto-browserify|stream-browserify|https-browserify|os-browserify|path-browserify|browserify-zlib|stream-http|assert)[\\/]/,
            priority: 35,
            enforce: true,
          },

          // SHARED: Common utilities in initial bundle
          utils: {
            name: 'utils',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](axios|chalk|ora)[\\/]/,
            priority: 30,
            enforce: true,
          },

          // ASYNC: Other vendor libraries load on-demand
          vendor: {
            name: 'vendor',
            chunks: 'async', // Changed from 'all' to 'async'
            test: /[\\/]node_modules[\\/]/,
            priority: 20,
            minChunks: 2,
          },

          // Common application code
          common: {
            name: 'common',
            chunks: 'all',
            minChunks: 2,
            priority: 10,
            reuseExistingChunk: true,
          },
        },
      }

      // Enhanced tree shaking
      config.optimization.usedExports = true
      config.optimization.sideEffects = false
      config.optimization.concatenateModules = true
      config.optimization.minimize = true
    }

    // Ignore source maps in production
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
    return []
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
    experimental: {
      bundlePagesExternals: false
    }
  }),
}

// Bundle analyzer
if (process.env.ANALYZE === 'true') {
  const withBundleAnalyzer = require('@next/bundle-analyzer')({
    enabled: true,
  })
  module.exports = withBundleAnalyzer(nextConfig)
} else {
  module.exports = nextConfig
}