#!/bin/bash

# Package Manager Standardization Script
# Helps choose between npm and pnpm and removes conflicting lockfiles

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📦 Package Manager Standardization${NC}"
echo "=================================="

# Check what package managers are available
HAS_NPM=$(command -v npm &> /dev/null && echo "yes" || echo "no")
HAS_PNPM=$(command -v pnpm &> /dev/null && echo "yes" || echo "no")
HAS_PACKAGE_LOCK=$([ -f "package-lock.json" ] && echo "yes" || echo "no")
HAS_PNPM_LOCK=$([ -f "pnpm-lock.yaml" ] && echo "yes" || echo "no")

echo -e "${BLUE}Current Status:${NC}"
echo "  npm available: $HAS_NPM"
echo "  pnpm available: $HAS_PNPM"
echo "  package-lock.json: $HAS_PACKAGE_LOCK"
echo "  pnpm-lock.yaml: $HAS_PNPM_LOCK"
echo ""

# If both lockfiles exist, show the conflict
if [ "$HAS_PACKAGE_LOCK" = "yes" ] && [ "$HAS_PNPM_LOCK" = "yes" ]; then
  echo -e "${YELLOW}⚠️  Conflict detected: Both lockfiles exist${NC}"
  echo ""
  echo -e "${BLUE}Lockfile ages:${NC}"
  ls -la package-lock.json pnpm-lock.yaml 2>/dev/null | awk '{print "  " $6 " " $7 " " $8 " " $9}'
  echo ""
fi

# Performance comparison
echo -e "${BLUE}📊 Performance Comparison:${NC}"
echo ""
echo -e "${GREEN}pnpm advantages:${NC}"
echo "  ✅ Faster installs (shared node_modules)"
echo "  ✅ Better disk space usage"
echo "  ✅ Stricter dependency resolution"
echo "  ✅ Built-in monorepo support"
echo ""
echo -e "${GREEN}npm advantages:${NC}"
echo "  ✅ Universal compatibility"
echo "  ✅ Default Node.js package manager"
echo "  ✅ Better CI/CD support"
echo "  ✅ Simpler deployment"
echo ""

# Recommendation
if [ "$HAS_PNPM" = "yes" ]; then
  echo -e "${BLUE}💡 Recommendation:${NC}"
  echo "  For development: ${GREEN}pnpm${NC} (faster, more efficient)"
  echo "  For production: ${GREEN}npm${NC} (more reliable on servers)"
else
  echo -e "${BLUE}💡 Recommendation:${NC}"
  echo "  Use ${GREEN}npm${NC} (pnpm not installed)"
fi

echo ""
echo -e "${BLUE}🛠️  Choose your action:${NC}"
echo "  1) Standardize on ${GREEN}npm${NC} (remove pnpm-lock.yaml)"
echo "  2) Standardize on ${GREEN}pnpm${NC} (remove package-lock.json)"
echo "  3) Keep both (fix deployment scripts only)"
echo "  4) Exit without changes"
echo ""

read -p "Enter your choice (1-4): " choice

case $choice in
  1)
    echo -e "${BLUE}📦 Standardizing on npm...${NC}"
    if [ -f "pnpm-lock.yaml" ]; then
      rm pnpm-lock.yaml
      echo "  ✅ Removed pnpm-lock.yaml"
    fi
    
    # Ensure package-lock.json is up to date
    echo "  🔄 Updating package-lock.json..."
    npm install
    
    echo -e "${GREEN}✅ Standardized on npm${NC}"
    echo "  📝 Use: npm install, npm run build, npm start"
    ;;
    
  2)
    echo -e "${BLUE}📦 Standardizing on pnpm...${NC}"
    if [ -f "package-lock.json" ]; then
      rm package-lock.json
      echo "  ✅ Removed package-lock.json"
    fi
    
    # Ensure pnpm-lock.yaml is up to date
    echo "  🔄 Updating pnpm-lock.yaml..."
    pnpm install
    
    echo -e "${GREEN}✅ Standardized on pnpm${NC}"
    echo "  📝 Use: pnpm install, pnpm run build, pnpm start"
    ;;
    
  3)
    echo -e "${YELLOW}📦 Keeping both package managers...${NC}"
    echo "  ✅ Deployment scripts already handle both"
    echo "  ⚠️  Team should agree on which to use for development"
    echo "  📝 npm for CI/CD, pnpm for local development is common"
    ;;
    
  4)
    echo -e "${BLUE}👋 No changes made${NC}"
    exit 0
    ;;
    
  *)
    echo -e "${RED}❌ Invalid choice${NC}"
    exit 1
    ;;
esac

echo ""
echo -e "${BLUE}📋 Summary:${NC}"
echo "  Current lockfiles:"
ls -1 package*.json pnpm-lock.yaml 2>/dev/null | sed 's/^/    /' || echo "    None found"

echo ""
echo -e "${BLUE}🚀 Next steps:${NC}"
echo "  1) Test installation: $([ -f "pnpm-lock.yaml" ] && echo "pnpm install" || echo "npm install")"
echo "  2) Run deployment: ./scripts/deploy-single-core.sh"
echo "  3) Commit changes to git"
echo ""
echo -e "${GREEN}🎉 Package manager standardization complete!${NC}" 