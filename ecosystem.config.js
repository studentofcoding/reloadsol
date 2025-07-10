module.exports = {
  apps: [
    {
      name: 'reloadsol',
      script: 'node',
      args: '.next/standalone/server.js',
      cwd: './',
      instances: 1, // Use only 1 CPU core (changed from 'max')
      exec_mode: 'cluster',
      
      // Environment
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // Add your production environment variables here
        // SUPABASE_URL: 'your-production-supabase-url',
        // SUPABASE_ANON_KEY: 'your-production-supabase-key',
      },
      
      // Performance & Monitoring (adjusted for single core)
      max_memory_restart: '800M', // Reduced from 1G for single core
      min_uptime: '10s',
      max_restarts: 10,
      autorestart: true,
      watch: false, // Disable in production
      
      // CPU throttling to ensure fair resource sharing
      node_args: '--max-old-space-size=768', // Limit heap to 768MB
      
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
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
      env: {
        NODE_ENV: 'production'
      }
    }
  }
} 