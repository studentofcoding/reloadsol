/** @type {import('next').NextConfig} */
const nextConfig = {
  // ===== CORE CONFIGURATION =====
  reactStrictMode: true,
  swcMinify: true, // Use SWC for faster builds
  poweredByHeader: false, // Remove X-Powered-By header for security
  
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
      'cdn.jsdelivr.net'
    ],
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
              script-src 'self' 'unsafe-eval' 'unsafe-inline' *.vercel-analytics.com;
              style-src 'self' 'unsafe-inline' fonts.googleapis.com;
              font-src 'self' fonts.gstatic.com;
              img-src 'self' data: blob: *.githubusercontent.com *.coingecko.com *.1inch.io *.vercel.app s3.coinmarketcap.com pbs.twimg.com ipfs.io arweave.net cdn.jsdelivr.net cryptologos.cc;
              connect-src 'self' *.supabase.co *.supabase.in *.shyft.to *.helius-rpc.com *.solana.com *.jup.ag *.jupiter-swap.com wss: https:;
              frame-src 'none';
              object-src 'none';
              base-uri 'self';
              form-action 'self';
            `.replace(/\s+/g, ' ').trim()
          }
        ]
      },
      // Cache static assets aggressively
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
    // Remove React dev tools in production
    reactRemoveProperties: process.env.NODE_ENV === 'production',
  },
  
  // ===== BUNDLE ANALYSIS =====
  ...(process.env.ANALYZE === 'true' && {
    experimental: {
      bundlePagesExternals: false
    }
  }),
  
  // ===== OUTPUT CONFIGURATION =====
  output: 'standalone', // Optimal for Docker/self-hosting
  
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
    
    // Production optimizations
    if (!dev && !isServer) {
      // Bundle splitting for better caching
      config.optimization.splitChunks = {
        chunks: 'all',
        cacheGroups: {
          default: false,
          vendors: false,
          // Solana libraries chunk
          solana: {
            name: 'solana',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](@solana|@metaplex)[\\/]/,
            priority: 40,
          },
          // React chunk
          react: {
            name: 'react',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/,
            priority: 30,
          },
          // Chart.js chunk  
          charts: {
            name: 'charts',
            chunks: 'all',
            test: /[\\/]node_modules[\\/](chart\.js|react-chartjs-2)[\\/]/,
            priority: 25,
          },
          // Common vendor libraries
          vendor: {
            name: 'vendor',
            chunks: 'all',
            test: /[\\/]node_modules[\\/]/,
            priority: 20,
          },
        },
      }
      
      // Tree shaking optimization
      config.optimization.usedExports = true
      config.optimization.sideEffects = false
    }
    
    // Ignore source maps in production for smaller builds
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
      // Add any redirects here if needed
    ]
  },
  
  async rewrites() {
    return [
      // Proxy RPC requests to avoid CORS issues
      {
        source: '/rpc/:path*',
        destination: '/api/rpc/:path*'
      }
    ]
  },
}

// Bundle analyzer (run with ANALYZE=true npm run build)
if (process.env.ANALYZE === 'true') {
  const withBundleAnalyzer = require('@next/bundle-analyzer')({
    enabled: true,
  })
  module.exports = withBundleAnalyzer(nextConfig)
} else {
  module.exports = nextConfig
} 