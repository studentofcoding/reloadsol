module.exports = {
  apps: [
    {
      name: 'reloadsol',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: './',
      instances: 1,
      exec_mode: 'cluster',

      // Environment
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        TZ: 'Asia/Bangkok', // UTC+7 (more explicit than Jakarta)
        // FIX: Add hostname for Server Actions
        HOSTNAME: 'localhost',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        TZ: 'Asia/Bangkok', // UTC+7 (more explicit than Jakarta)
        // FIX: Add production hostname
        HOSTNAME: '161.97.82.10', // Your server IP
        // Or use your domain: HOSTNAME: 'reloadsol.xyz',
      },

      // Performance & Monitoring
      max_memory_restart: '800M',
      min_uptime: '10s',
      max_restarts: 10,
      autorestart: true,
      watch: false,

      // CPU throttling
      node_args: '--max-old-space-size=768',

      // Logging
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Advanced PM2 settings
      kill_timeout: 5000,
      listen_timeout: 3000,
      wait_ready: true,

      // Health check
      health_check_grace_period: 3000,
    }
  ],

  deploy: {
    production: {
      user: 'root', // Change to your server user
      host: '161.97.82.10', // Your server IP
      ref: 'origin/main',
      repo: 'git@github.com:your-username/your-repo.git', // Update with your repo
      path: '/var/www/reloadsol',
      'pre-deploy-local': '',
      'post-deploy': 'pnpm install && pnpm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Bangkok' // Ensure timezone is set in deployment env too
      }
    }
  }
}