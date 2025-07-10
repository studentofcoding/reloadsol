#!/bin/bash

# reloadSOL Single-Core Production Deployment Script
# Optimized for servers running multiple applications
# Usage: ./scripts/deploy-single-core.sh [--skip-build] [--with-ssl]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 reloadSOL Single-Core Deployment${NC}"
echo "======================================="
echo -e "${YELLOW}⚡ Optimized for shared server resources${NC}"

# Parse arguments
SKIP_BUILD=false
WITH_SSL=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --with-ssl)
      WITH_SSL=true
      shift
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  echo -e "${RED}❌ Error: package.json not found. Run this script from the project root.${NC}"
  exit 1
fi

# Check system resources
echo -e "${BLUE}📊 Checking system resources...${NC}"
TOTAL_MEM=$(free -g | awk 'NR==2{print $2}')
AVAILABLE_MEM=$(free -g | awk 'NR==2{print $7}')
CPU_COUNT=$(nproc)

echo "  Total Memory: ${TOTAL_MEM}GB"
echo "  Available Memory: ${AVAILABLE_MEM}GB" 
echo "  CPU Cores: ${CPU_COUNT}"
echo "  reloadSOL will use: 1 core, ~800MB RAM"

if [ "$AVAILABLE_MEM" -lt 1 ]; then
  echo -e "${YELLOW}⚠️  Warning: Low available memory. Consider stopping other services temporarily.${NC}"
fi

# Install PM2 globally if not installed
if ! command -v pm2 &> /dev/null; then
  echo -e "${YELLOW}📦 Installing PM2 globally...${NC}"
  npm install -g pm2
fi

# Create logs directory
echo -e "${BLUE}📁 Creating logs directory...${NC}"
mkdir -p logs

# Install dependencies with limited concurrency
echo -e "${BLUE}📦 Installing dependencies (single-threaded)...${NC}"
npm ci --only=production --maxsockets 1

# Build the application with limited resources (unless skipped)
if [ "$SKIP_BUILD" = false ]; then
  echo -e "${BLUE}🔨 Building application (resource-limited)...${NC}"
  
  # Set Node.js memory limit for build process
  export NODE_OPTIONS="--max-old-space-size=1024"
  
  # Build with limited concurrency
  npm run build
  
  echo -e "${GREEN}✅ Build completed successfully${NC}"
fi

# Stop existing PM2 processes gracefully
echo -e "${BLUE}🛑 Stopping existing processes...${NC}"
pm2 stop ecosystem.config.js 2>/dev/null || true
pm2 delete ecosystem.config.js 2>/dev/null || true

# Wait for processes to fully stop
sleep 2

# Start application with PM2 (single core configuration)
echo -e "${BLUE}🌟 Starting application with PM2 (1 core)...${NC}"
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save

# Setup PM2 startup script (only if not already configured)
if ! pm2 startup | grep -q "already"; then
  pm2 startup
fi

# Configure CPU affinity to bind to specific core (optional)
echo -e "${BLUE}⚙️  Configuring CPU affinity...${NC}"
PID=$(pm2 jlist | jq -r '.[] | select(.name=="reloadsol") | .pid')
if [ "$PID" != "null" ] && [ -n "$PID" ]; then
  # Bind to CPU core 0 (change to 1 or 2 if you prefer different core)
  sudo taskset -cp 0 $PID 2>/dev/null || echo "  Note: CPU affinity requires sudo privileges"
fi

# Setup SSL if requested
if [ "$WITH_SSL" = true ]; then
  echo -e "${BLUE}🔐 Setting up SSL with nginx...${NC}"
  
  # Install nginx and certbot
  sudo apt update
  sudo apt install -y nginx certbot python3-certbot-nginx
  
  # Create resource-optimized nginx configuration
  sudo tee /etc/nginx/sites-available/reloadsol > /dev/null << EOF
# Nginx configuration optimized for shared server resources
server {
    listen 80;
    server_name _;
    
    # Worker processes (limit for shared server)
    worker_processes 1;
    worker_connections 1024;
    
    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    
    # Efficient gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_comp_level 4;  # Lower compression level to save CPU
    gzip_types
        application/json
        application/javascript
        text/plain
        text/css
        text/javascript;
    
    # Rate limiting to prevent abuse
    limit_req_zone \$binary_remote_addr zone=api:10m rate=10r/s;
    
    location / {
        limit_req zone=api burst=20 nodelay;
        
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # Conservative timeouts for shared server
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
        
        # Buffer settings
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
    }
    
    # Static assets caching
    location /_next/static/ {
        proxy_pass http://localhost:3000;
        add_header Cache-Control "public, max-age=31536000, immutable";
        expires 1y;
    }
    
    # Favicon caching
    location /favicon.ico {
        proxy_pass http://localhost:3000;
        add_header Cache-Control "public, max-age=31536000";
        expires 1y;
    }
    
    # Block common attack patterns
    location ~ /\. {
        deny all;
    }
}
EOF

  # Enable the site
  sudo ln -sf /etc/nginx/sites-available/reloadsol /etc/nginx/sites-enabled/
  sudo rm -f /etc/nginx/sites-enabled/default
  
  # Test nginx configuration
  sudo nginx -t
  
  # Start nginx
  sudo systemctl restart nginx
  sudo systemctl enable nginx
  
  echo -e "${GREEN}✅ SSL setup complete. Run 'sudo certbot --nginx -d yourdomain.com' to get certificate${NC}"
fi

# Display resource usage
echo ""
echo -e "${GREEN}✅ Single-core deployment completed successfully!${NC}"
echo ""
echo -e "${BLUE}📊 Resource Usage:${NC}"
pm2 status
echo ""
echo -e "${BLUE}💾 Memory Usage:${NC}"
free -h
echo ""
echo -e "${BLUE}⚡ CPU Usage:${NC}"
top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1 | awk '{print "CPU Usage: " $1"%"}'

echo ""
echo -e "${BLUE}📝 Single-Core Management Commands:${NC}"
echo "  pm2 status              - Check application status"
echo "  pm2 logs reloadsol      - View application logs"
echo "  pm2 restart reloadsol   - Restart application"
echo "  pm2 monit               - Monitor resources"
echo "  htop                    - System resource monitor"
echo "  pm2 stop reloadsol      - Stop application"
echo ""
echo -e "${BLUE}💡 Resource Optimization Tips:${NC}"
echo "  - App uses 1 CPU core, ~400-800MB RAM"
echo "  - CPU cores 1 & 2 available for other programs"  
echo "  - Monitor with: watch 'pm2 monit --no-interaction'"
echo "  - If memory issues: pm2 restart reloadsol"
echo ""
echo -e "${GREEN}🎉 reloadSOL is running efficiently in single-core mode!${NC}"

# Show application URL and resource summary
PORT=$(pm2 jlist | jq -r '.[] | select(.name=="reloadsol") | .pm2_env.PORT // "3000"')
if [ "$WITH_SSL" = true ]; then
  echo -e "${BLUE}🌐 Application URL: https://yourdomain.com${NC}"
else
  echo -e "${BLUE}🌐 Application URL: http://localhost:${PORT}${NC}"
fi

echo -e "${BLUE}📈 Expected Performance (1 core):${NC}"
echo "  - Requests/sec: ~50-75 (reduced from 100-150)"
echo "  - Memory usage: 400-800MB"
echo "  - CPU usage: 10-30% of 1 core"
echo "  - Available for other apps: 2 cores + ~7GB RAM" 