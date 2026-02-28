const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function testCapture() {
  console.log("Starting Puppeteer capture test...");

  // Test token (SOL/USD)
  const tokenAddress = "3dG3rrEFZjzUmKEKzy4BWA9U8o7ZzVxZowsZNgtNpump";
  const url = `https://www.gmgn.cc/kline/sol/${tokenAddress}?interval=5`;

  console.log(`Navigating to: ${url}`);

  try {
    const browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1280, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const page = await browser.newPage();

    // Set Headers
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'max-age=0',
      'priority': 'u=0, i',
      'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1'
    });

    // 2. Go to URL and Wait
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log("Page loaded (domcontentloaded)");

    // Wait for selector (mimicking route.ts)
    try {
      await page.waitForSelector('[aria-label="Take a snapshot"], canvas', { timeout: 15000 });
      console.log("Selector found");
    } catch (e) {
      console.log("Selector wait timeout (might be fine if chart loaded differently)");
    }

    // Fixed wait
    console.log("Waiting 3s for render...");
    await new Promise(r => setTimeout(r, 3000));

    // 3. Cleanup UI
    await page.addStyleTag({
      content: `
        header, footer, .popup, nav, .cookie-banner { display: none !important; }
        button:not([aria-label="Take a snapshot"]), .trade-panel { opacity: 0; } 
        [aria-label="Take a snapshot"] { display: none !important; }
      `
    });

    // 4. Capture
    console.log("Capturing screenshot...");
    const chartContainer = await page.$('div[id^="tradingview_"]');
    const canvas = await page.$('canvas');

    let buffer;
    if (chartContainer) {
      console.log("Found chart container");
      buffer = await chartContainer.screenshot({ type: 'png' });
    } else if (canvas) {
      console.log("Found canvas");
      // Try parent
      const canvasParent = await canvas.evaluateHandle(el => el.parentElement);
      const parentElement = canvasParent.asElement();
      if (parentElement) {
        buffer = await parentElement.screenshot({ type: 'png' });
      } else {
        buffer = await page.screenshot({ type: 'png', fullPage: false });
      }
    } else {
      console.log("Fallback to full page");
      buffer = await page.screenshot({ type: 'png', fullPage: false });
    }

    // Save locally
    const debugDir = path.join(process.cwd(), 'src', 'app', 'charts', 'debug-screenshots');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }
    const filePath = path.join(debugDir, `test-capture-${Date.now()}.png`);
    fs.writeFileSync(filePath, buffer);

    console.log(`SUCCESS: Screenshot saved to ${filePath}`);

    await browser.close();

  } catch (error) {
    console.error("ERROR:", error);
    process.exit(1);
  }
}

testCapture();
