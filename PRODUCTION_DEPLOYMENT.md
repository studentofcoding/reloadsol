# 🚀 reloadSOL Production Deployment Guide

## Overview

This guide covers deploying the optimized reloadSOL Next.js application on your Contabo VPS (3 vCPU, 8GB RAM) with maximum performance and security.

## ✅ Optimizations Applied

### Next.js 14.0.0 Configuration
- **SWC Minification**: Faster builds and smaller bundles
- **Bundle Splitting**: Optimized chunks for better caching
  - Solana libraries chunk (40KB saved on cache hits)
  - React libraries chunk 
  - Charts.js chunk
  - Vendor libraries chunk
- **Tree Shaking**: Removes unused code
- **Console Removal**: Production console logs stripped
- **Standalone Output**: Optimal for self-hosting
- **Image Optimization**: WebP/AVIF support with 30-day cache
- **Compression**: gzip enabled for all assets

### Security Headers
- **CSP**: Content Security Policy for XSS protection
- **Frame Options**: Prevents clickjacking
- **HTTPS Enforcement**: Wallet connection compatibility
- **Asset Caching**: 1-year cache for static assets

### Performance Features
- **PM2 Clustering**: Configurable for 1 or 3 CPU cores
- **Memory Management**: Auto-restart at 800MB-1GB usage
- **Health Monitoring**: Built-in health checks
- **Bundle Analysis**: Size optimization tracking

## 📊 Expected Performance

### Server Resources (3 vCPU, 8GB RAM)

#### Full Resource Usage (3 cores)
- **Memory Usage**: 200-400MB (peaks at 600MB during GC)
- **CPU Usage**: <2% idle, 10-50ms spikes per request
- **Capacity**: ~100-150 requests/second
- **Build Time**: 60-120 seconds

#### Single Core Usage (recommended for shared servers)
- **Memory Usage**: 400-800MB (limited to single process)
- **CPU Usage**: 10-30% of 1 core only
- **Capacity**: ~50-75 requests/second
- **Available for other apps**: 2 cores + ~7GB RAM

### Bundle Sizes
- **Main Bundle**: 313KB (shared by all pages)
- **Vendor Chunk**: 310KB (Solana + React libraries)
- **Page Bundles**: 8-83KB (depending on complexity)
- **Total First Load**: 359KB for home page

## 🔧 Deployment Options

### Option 1: Single-Core Deployment (Recommended for Shared Servers)

**Perfect when running other programs on the same server**

```bash
# Clone your repository
git clone https://github.com/your-username/reloadsol.git
cd reloadsol

# Run single-core deployment
chmod +x scripts/deploy-single-core.sh
./scripts/deploy-single-core.sh --with-ssl

# Follow prompts for SSL certificate
sudo certbot --nginx -d yourdomain.com
```

**Resource allocation:**
- reloadSOL: 1 CPU core + ~800MB RAM
- Other programs: 2 CPU cores + ~7GB RAM

### Option 2: Full Resource Deployment

**Use when reloadSOL is the primary application**

```bash
# Clone your repository
git clone https://github.com/your-username/reloadsol.git
cd reloadsol

# Run full deployment
chmod +x scripts/deploy.sh
./scripts/deploy.sh --with-ssl

# Follow prompts for SSL certificate
sudo certbot --nginx -d yourdomain.com
```

### Option 3: Manual Deployment

```bash
# Install dependencies
npm ci --only=production

# Build application
npm run build

# Install PM2 globally
sudo npm install -g pm2

# Start with PM2 (single-core)
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

### Option 4: Docker Deployment

```bash
# Build Docker image
docker build -t reloadsol .

# Run container (resource-limited)
docker run -p 3000:3000 \
  --cpus="1.0" \
  --memory="800m" \
  -e NODE_ENV=production \
  -e SUPABASE_URL=your-url \
  -e SUPABASE_ANON_KEY=your-key \
  reloadsol
```

## ⚙️ Resource Management

### CPU Affinity (Advanced)
Bind reloadSOL to a specific CPU core:

```bash
# Find reloadSOL process ID
PID=$(pm2 jlist | jq -r '.[] | select(.name=="reloadsol") | .pid')

# Bind to CPU core 0 (cores 1 & 2 free for other apps)
sudo taskset -cp 0 $PID

# Verify CPU affinity
taskset -cp $PID
```

### Memory Monitoring
```bash
# Monitor memory usage
watch 'pm2 monit --no-interaction'

# Check system memory
free -h

# Restart if memory usage is high
pm2 restart reloadsol
```

### Performance Comparison

| Configuration | CPU Cores | Memory | Requests/sec | Available Resources |
|---------------|-----------|--------|--------------|-------------------|
| Single-Core   | 1 core    | 800MB  | 50-75       | 2 cores + 7GB     |
| Full Resource | 3 cores   | 400MB  | 100-150     | 0 cores + 7.6GB   |

## 🔐 SSL/HTTPS Setup (Required for Wallet Connection)

### Why HTTPS is Required
Solana wallets (Phantom, Solflare) require HTTPS for security in production.

### Quick SSL Setup
```bash
# Install nginx and certbot
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx

# Use automated script (single-core)
./scripts/deploy-single-core.sh --with-ssl

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com
```

### Manual Nginx Configuration
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    # Rate limiting for shared servers
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    
    location / {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 📊 Monitoring & Maintenance

### PM2 Commands
```bash
# Check status
pm2 status

# View logs
pm2 logs reloadsol

# Monitor resources (single-core specific)
pm2 monit

# Restart (zero-downtime)
pm2 reload reloadsol

# Stop application
pm2 stop reloadsol
```

### Resource Monitoring
```bash
# Application health
curl http://localhost:3000/api/health

# System resource check
pm2 status && df -h && free -h

# CPU usage per core
htop  # Press F2 -> Display options -> Show detailed CPU time

# Check which core reloadSOL is using
ps -eLo pid,ppid,tid,cls,rtprio,pri,psr,pcpu,stat,wchan:14,comm | grep node
```

### Bundle Analysis
```bash
# Analyze bundle size
npm run build:analyze

# View results
open .next/analyze/bundle.html
```

## 🔧 Environment Variables

Create `.env.production.local`:
```env
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1

# Supabase Configuration
SUPABASE_URL=your-production-supabase-url
SUPABASE_ANON_KEY=your-production-supabase-key

# Trading Configuration (if using real trading)
TRADING_KEYPAIR_JSON=[123,45,67,89...] # Your wallet private key array
DISCORD_WEBHOOK_AUTO_TRADE=https://discord.com/api/webhooks/your-webhook

# Performance Limits (adjusted for single-core)
MAX_SOL_AT_RISK=1.0
MIN_SOL_BALANCE=0.1

# Node.js optimization for single core
NODE_OPTIONS=--max-old-space-size=768
```

## 🚨 Security Checklist

- [ ] HTTPS certificate installed
- [ ] Environment variables secured
- [ ] Trading keypair protected
- [ ] Firewall configured (ports 80, 443, 22 only)
- [ ] SSH key authentication enabled
- [ ] Regular security updates enabled
- [ ] Discord webhook secured
- [ ] Database access restricted
- [ ] CPU affinity configured (if using single-core)

## 📈 Performance Optimization Tips

### 1. Single-Core Optimization
```bash
# Set CPU governor to performance mode
echo performance | sudo tee /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

# Monitor core-specific usage
watch 'cat /proc/loadavg && echo "Core 0:" && cat /proc/cpuinfo | grep "processor.*0" -A 10'
```

### 2. Database Optimization
```sql
-- Add indexes for frequently queried columns
CREATE INDEX idx_token_address ON trending_token_tracker(token_address);
CREATE INDEX idx_status ON trending_token_tracker(status);
CREATE INDEX idx_tracking_started ON trending_token_tracker(tracking_started_at);
```

### 3. Memory Optimization for Single Core
```bash
# Enable memory compression
echo 1 | sudo tee /proc/sys/vm/compact_memory

# Adjust swappiness for better performance
echo 10 | sudo tee /proc/sys/vm/swappiness
```

### 4. Process Monitoring
```bash
# Monitor reloadSOL process specifically
watch 'ps -p $(pm2 jlist | jq -r ".[] | select(.name==\"reloadsol\") | .pid") -o pid,ppid,cpu,pmem,time,comm'

# Check if process is bound to correct core
taskset -cp $(pm2 jlist | jq -r '.[] | select(.name=="reloadsol") | .pid')
```

## 🐛 Troubleshooting

### Common Issues

**Wallet won't connect:**
- Ensure HTTPS is properly configured
- Check browser console for errors
- Verify wallet extension is installed

**High CPU usage on shared server:**
- Verify CPU affinity: `taskset -cp $(pgrep node)`
- Check if bound to single core
- Monitor with `htop` and verify only 1 core is used

**Memory pressure:**
- Monitor with `pm2 monit`
- Restart if memory exceeds 800MB
- Check for memory leaks in logs

**Slow response times (single-core):**
- Expected: 50-75 req/sec (vs 100-150 on 3 cores)
- Check RPC endpoint health
- Monitor database query performance
- Verify only 1 core is being used

### Resource Conflicts
```bash
# Check what else is using CPU
top -H -p $(pgrep -d',' -f node)

# Monitor memory per process
ps aux --sort=-%mem | head -10

# Check if other processes are competing
iotop -ao -d 1
```

## 📞 Support & Maintenance

### Regular Maintenance Tasks
- Weekly security updates: `sudo apt update && sudo apt upgrade`
- Monthly dependency updates: `npm audit fix`
- SSL certificate renewal: automatic with certbot
- Database cleanup: purge old records monthly
- Log rotation: configure with logrotate
- CPU affinity verification: ensure process stays on assigned core

### Performance Baselines

#### Single-Core Mode
- Initial load: <3 seconds
- API response time: <300ms average
- Memory usage: <800MB normal operation
- CPU usage: <30% of assigned core

#### Full Resource Mode
- Initial load: <2 seconds
- API response time: <200ms average
- Memory usage: <500MB normal operation
- CPU usage: <20% average across cores

### Scaling Considerations
- **Single-core scaling**: Monitor CPU usage of assigned core, scale up when >70%
- **Memory scaling**: Add swap or upgrade RAM when consistently >6GB used
- **Horizontal scaling**: Add load balancer + multiple single-core instances
- **Database scaling**: Consider read replicas for heavy queries

---

## 🎉 Deployment Complete!

Your reloadSOL application is now optimized and ready for production with:
- ✅ **Flexible resource usage**: 1 core or 3 cores based on your needs
- ✅ **HTTPS support** for wallet connections  
- ✅ **Security headers** and protections
- ✅ **Resource monitoring** and health checks
- ✅ **Automated deployment** scripts
- ✅ **Production-grade** configuration
- ✅ **Shared server** compatibility

**Deployment Commands:**

```bash
# For shared servers (recommended)
./scripts/deploy-single-core.sh --with-ssl

# For dedicated servers
./scripts/deploy.sh --with-ssl
```

**Resource Summary:**
- **Single-core**: 1 CPU + 800MB RAM (leaves 2 cores + 7GB for other apps)
- **Full resource**: 3 CPUs + 400MB RAM (dedicates server to reloadSOL)

Happy trading! 🚀 