#!/usr/bin/env node

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Configuration with smart URL parsing
function parseHostConfig() {
  const envHost = process.env.API_HOST || 'https://reloadsol.app/';
  
  // Check if it's a full URL
  if (envHost.startsWith('http://') || envHost.startsWith('https://')) {
    const url = new URL(envHost);
    return {
      protocol: url.protocol.slice(0, -1), // Remove trailing ':'
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      secure: url.protocol === 'https:'
    };
  }
  
  // Legacy hostname:port format
  const [hostname, port] = envHost.split(':');
  return {
    protocol: process.env.API_SECURE === 'true' ? 'https' : 'http',
    hostname: hostname || 'localhost',
    port: parseInt(port) || 3000,
    secure: process.env.API_SECURE === 'true'
  };
}

const CONFIG = {
  ...parseHostConfig(),
  endpoint: '/api/logs',
  streamEndpoint: '/api/logs/stream',
  maxRetries: 3,
  retryDelay: 3000,
  keepAliveTimeout: 30000
};

// Colors for console output
const colors = {
  debug: '\x1b[36m',   // Cyan
  info: '\x1b[32m',    // Green  
  warn: '\x1b[33m',    // Yellow
  error: '\x1b[31m',   // Red
  critical: '\x1b[35m', // Magenta
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    level: null,
    endpoint: null,
    method: null,
    follow: false,
    limit: 50,
    stats: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '-f':
      case '--follow':
        options.follow = true;
        break;
      case '-l':
      case '--level':
        options.level = args[++i];
        break;
      case '-e':
      case '--endpoint':
        options.endpoint = args[++i];
        break;
      case '-m':
      case '--method':
        options.method = args[++i];
        break;
      case '-n':
      case '--lines':
        options.limit = parseInt(args[++i]) || 50;
        break;
      case '-s':
      case '--stats':
        options.stats = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return options;
}

// Show help
function showHelp() {
  console.log(`
${colors.bold}API Log Tailer${colors.reset}

Usage: node scripts/tail-logs.js [options]

Options:
  -f, --follow          Follow log output (real-time streaming)
  -l, --level LEVEL     Filter by log level (debug, info, warn, error, critical)
  -e, --endpoint PATH   Filter by endpoint path (e.g., /api/trending)
  -m, --method METHOD   Filter by HTTP method (GET, POST, PUT, DELETE)
  -n, --lines NUMBER    Number of lines to show (default: 50)
  -s, --stats          Show log statistics only
  -h, --help           Show this help

Examples:
  node scripts/tail-logs.js                           # Show last 50 logs
  node scripts/tail-logs.js -f                        # Follow logs in real-time
  node scripts/tail-logs.js -l error                  # Show only error logs
  node scripts/tail-logs.js -e /api/trending          # Show trending API logs
  node scripts/tail-logs.js -f -l warn -e /api/trade  # Follow warnings from trade API
  node scripts/tail-logs.js -s                        # Show statistics

Environment Variables:
  API_HOST     Target host (default: localhost:3000)
  API_SECURE   Use HTTPS (default: false)
`);
}

// Format log entry for console output
function formatLogTimestamp(isoTimestamp) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(isoTimestamp));
}

function formatLog(log) {
  const timestamp = formatLogTimestamp(log.timestamp);
  const level = log.level.toUpperCase().padEnd(8);
  const method = log.method.padEnd(6);
  const endpoint = log.endpoint;
  const duration = log.duration ? `${log.duration}ms` : '';
  const status = log.response?.statusCode || '';
  
  const levelColor = colors[log.level] || colors.reset;
  const statusColor = status >= 500 ? colors.error : 
                     status >= 400 ? colors.warn : 
                     status >= 200 ? colors.info : colors.reset;
  
  let output = `${colors.dim}[${timestamp}]${colors.reset} `;
  output += `${levelColor}${level}${colors.reset} `;
  output += `${colors.bold}${method}${colors.reset} `;
  output += `${endpoint} `;
  
  if (status) {
    output += `${statusColor}[${status}]${colors.reset} `;
  }
  
  if (duration) {
    output += `${colors.dim}[${duration}]${colors.reset} `;
  }
  
  output += `- ${log.message}`;
  
  if (log.error) {
    output += `\n  ${colors.error}ERROR: ${log.error.message}${colors.reset}`;
  }
  
  return output;
}

// Make HTTP request with better error handling
function makeRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const protocol = CONFIG.secure ? https : http;
    const url = new URL(`${CONFIG.protocol}://${CONFIG.hostname}:${CONFIG.port}${path}`);
    
    // Add query parameters
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, value.toString());
      }
    });

    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: url.pathname + url.search,
      method: 'GET',
      timeout: 15000,
      // Allow self-signed certificates in development
      rejectUnauthorized: CONFIG.hostname !== 'localhost'
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (error) {
          resolve({ raw: data });
        }
      });
    });

    req.on('error', (error) => {
      // Provide more helpful error messages
      if (error.code === 'ENOTFOUND') {
        reject(new Error(`Host not found: ${CONFIG.hostname}. Check your API_HOST setting.`));
      } else if (error.code === 'ECONNREFUSED') {
        reject(new Error(`Connection refused to ${CONFIG.hostname}:${CONFIG.port}. Is the server running?`));
      } else if (error.code === 'CERT_HAS_EXPIRED' || error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        reject(new Error(`SSL certificate error for ${CONFIG.hostname}. Try setting NODE_TLS_REJECT_UNAUTHORIZED=0 for testing.`));
      } else {
        reject(error);
      }
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout connecting to ${CONFIG.hostname}:${CONFIG.port}`));
    });

    req.end();
  });
}

// Global state for connection management
let isReconnecting = false;
let currentConnection = null;

// Follow logs with automatic reconnection
function followLogs(options, retryCount = 0) {
  // Prevent multiple simultaneous reconnection attempts
  if (isReconnecting && retryCount > 0) {
    return;
  }
  
  if (retryCount > 0) {
    isReconnecting = true;
  }

  console.log(`${colors.info}Following logs from ${CONFIG.protocol}://${CONFIG.hostname}:${CONFIG.port}...${colors.reset}`);
  if (retryCount > 0) {
    console.log(`${colors.warn}Reconnection attempt ${retryCount}/${CONFIG.maxRetries}${colors.reset}`);
  }
  console.log(`${colors.dim}Press Ctrl+C to stop${colors.reset}\n`);

  const protocol = CONFIG.secure ? https : http;
  const url = new URL(`${CONFIG.protocol}://${CONFIG.hostname}:${CONFIG.port}${CONFIG.streamEndpoint}`);
  
  // Add query parameters
  if (options.level) url.searchParams.set('level', options.level);
  if (options.endpoint) url.searchParams.set('endpoint', options.endpoint);
  if (options.method) url.searchParams.set('method', options.method);

  const requestOptions = {
    hostname: CONFIG.hostname,
    port: CONFIG.port,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'User-Agent': 'ReloadSOL-LogTailer/1.0'
    },
    timeout: CONFIG.keepAliveTimeout,
    // Allow self-signed certificates in development
    rejectUnauthorized: CONFIG.hostname !== 'localhost',
    // Enable keep-alive for better connection handling
    keepAlive: true,
    keepAliveInitialDelay: 10000
  };

  const req = protocol.request(requestOptions, (res) => {
    // Reset retry count and reconnection flag on successful connection
    retryCount = 0;
    isReconnecting = false;
    
    // Set up response timeout
    res.setTimeout(CONFIG.keepAliveTimeout, () => {
      console.log(`${colors.warn}Response timeout, reconnecting...${colors.reset}`);
      req.destroy();
      attemptReconnection(options, retryCount);
    });
    
    res.on('data', (chunk) => {
      const data = chunk.toString();
      const lines = data.split('\n');
      
      lines.forEach(line => {
        if (line.startsWith('data: ')) {
          try {
            const eventData = JSON.parse(line.slice(6));
            
            if (eventData.type === 'log') {
              console.log(formatLog(eventData.log));
            } else if (eventData.type === 'connected') {
              console.log(`${colors.info}✓ ${eventData.message}${colors.reset}\n`);
            } else if (eventData.type === 'error') {
              console.error(`${colors.error}✗ ${eventData.message}${colors.reset}`);
            }
          } catch (error) {
            // Ignore parsing errors for SSE heartbeats
          }
        }
      });
    });
    
    res.on('end', () => {
      console.log(`\n${colors.warn}Connection closed by server${colors.reset}`);
      if (!isReconnecting) {
        attemptReconnection(options, retryCount);
      }
    });
    
    res.on('error', (error) => {
      console.error(`${colors.error}Response error: ${error.message}${colors.reset}`);
      if (!isReconnecting) {
        attemptReconnection(options, retryCount);
      }
    });
  });

  req.on('error', (error) => {
    let errorMessage = `Connection error: ${error.message}`;
    
    // Provide more helpful error messages
    if (error.code === 'ENOTFOUND') {
      errorMessage = `Host not found: ${CONFIG.hostname}. Check your API_HOST setting.`;
    } else if (error.code === 'ECONNREFUSED') {
      errorMessage = `Connection refused to ${CONFIG.hostname}:${CONFIG.port}. Is the server running?`;
    } else if (error.code === 'CERT_HAS_EXPIRED' || error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      errorMessage = `SSL certificate error for ${CONFIG.hostname}. Try setting NODE_TLS_REJECT_UNAUTHORIZED=0 for testing.`;
    } else if (error.code === 'ECONNRESET') {
      errorMessage = `Connection reset by ${CONFIG.hostname}. Server may be restarting.`;
    }
    
    console.error(`${colors.error}${errorMessage}${colors.reset}`);
    if (!isReconnecting) {
      attemptReconnection(options, retryCount);
    }
  });

  req.on('timeout', () => {
    console.error(`${colors.error}Connection timeout to ${CONFIG.hostname}:${CONFIG.port}${colors.reset}`);
    req.destroy();
    if (!isReconnecting) {
      attemptReconnection(options, retryCount);
    }
  });

  req.end();

  // Store current connection
  currentConnection = req;

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log(`\n${colors.info}Stopping log tail...${colors.reset}`);
    if (currentConnection) {
      currentConnection.destroy();
    }
    process.exit(0);
  });
}

// Attempt reconnection with exponential backoff
function attemptReconnection(options, retryCount) {
  if (isReconnecting) {
    return; // Already reconnecting
  }
  
  if (retryCount >= CONFIG.maxRetries) {
    console.error(`${colors.error}Max retries (${CONFIG.maxRetries}) exceeded. Giving up.${colors.reset}`);
    process.exit(1);
  }
  
  isReconnecting = true;
  const delay = CONFIG.retryDelay + (retryCount * 1000); // Linear backoff
  console.log(`${colors.warn}Retrying in ${delay/1000} seconds...${colors.reset}`);
  
  setTimeout(() => {
    followLogs(options, retryCount + 1);
  }, delay);
}

// Show statistics
async function showStats() {
  try {
    const response = await makeRequest(CONFIG.endpoint, { stats: true });
    
    if (!response.success) {
      console.error(`${colors.error}Failed to fetch stats${colors.reset}`);
      return;
    }

    const stats = response.stats;
    
    console.log(`${colors.bold}API Log Statistics${colors.reset}\n`);
    console.log(`Total Logs: ${colors.info}${stats.totalLogs}${colors.reset}`);
    console.log(`Average Response Time: ${colors.info}${stats.averageResponseTime}ms${colors.reset}`);
    console.log(`Error Rate: ${colors[stats.errorRate > 10 ? 'error' : 'info']}${stats.errorRate}%${colors.reset}\n`);
    
    console.log(`${colors.bold}Logs by Level:${colors.reset}`);
    Object.entries(stats.logsByLevel).forEach(([level, count]) => {
      const color = colors[level] || colors.reset;
      console.log(`  ${color}${level.padEnd(8)}${colors.reset}: ${count}`);
    });
    
    console.log(`\n${colors.bold}Top Endpoints:${colors.reset}`);
    const sortedEndpoints = Object.entries(stats.logsByEndpoint)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10);
    
    sortedEndpoints.forEach(([endpoint, count]) => {
      console.log(`  ${endpoint.padEnd(30)}: ${colors.info}${count}${colors.reset}`);
    });
    
  } catch (error) {
    console.error(`${colors.error}Error fetching stats: ${error.message}${colors.reset}`);
  }
}

// Fetch and display logs
async function showLogs(options) {
  try {
    const params = {
      limit: options.limit,
      level: options.level,
      endpoint: options.endpoint,
      method: options.method
    };

    const response = await makeRequest(CONFIG.endpoint, params);
    
    if (!response.success) {
      console.error(`${colors.error}Failed to fetch logs${colors.reset}`);
      return;
    }

    console.log(`${colors.info}Showing ${response.count} logs${colors.reset}\n`);
    
    response.logs.forEach(log => {
      console.log(formatLog(log));
    });
    
  } catch (error) {
    console.error(`${colors.error}Error fetching logs: ${error.message}${colors.reset}`);
  }
}

// Main function
async function main() {
  const options = parseArgs();
  
  if (options.help) {
    showHelp();
    return;
  }
  
  if (options.stats) {
    await showStats();
    return;
  }
  
  if (options.follow) {
    followLogs(options);
    return;
  }
  
  await showLogs(options);
}

// Run the script
main().catch(error => {
  console.error(`${colors.error}Fatal error: ${error.message}${colors.reset}`);
  process.exit(1);
}); 