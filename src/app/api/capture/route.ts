import { NextResponse } from 'next/server';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

export async function POST(req: Request) {
  try {
    const { tokenAddress } = await req.json();
    if (!tokenAddress) {
      return NextResponse.json({ error: "Token address required" }, { status: 400 });
    }

    const url = `https://www.gmgn.cc/kline/sol/${tokenAddress}?interval=5`;

    // 1. Launch Browser
    const browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1280, height: 800 },
      // Add args for better compatibility in restricted environments if needed
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled' // Helps bypass detection
      ]
    });

    try {
      const page = await browser.newPage();

      // Set User Agent and Headers to mimic a real user
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
        'sec-fetch-site': 'none', // Changed from same-origin for initial navigation
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1'
      });

      // 2. Go to URL and Wait
      // 'networkidle0' might be too slow for GMGN if it has streaming data. 
      // 'domcontentloaded' + a fixed wait is often more robust for charts.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for the chart widget to load by looking for the screenshot button or chart container
      // This ensures we don't take a screenshot of a loading spinner
      try {
        await page.waitForSelector('[aria-label="Take a snapshot"], canvas', { timeout: 15000 });
      } catch (e) {
        console.log("Screenshot button not found, proceeding anyway");
      }

      // Wait extra time for the chart canvas to actually render content
      await new Promise(r => setTimeout(r, 3000));

      // 3. Remove Popups/Overlays
      await page.addStyleTag({
        content: `
          header, footer, .popup, nav, .cookie-banner { display: none !important; }
          /* Hide trading buttons overlay if present to get clean chart */
          button:not([aria-label="Take a snapshot"]), .trade-panel { opacity: 0; } 
          /* Hide the screenshot button itself from the capture if we are doing manual capture */
          [aria-label="Take a snapshot"] { display: none !important; }
        `
      });

      // 4. Screenshot strategy: Target the chart container
      // This produces a cleaner result similar to the native button but more robustly

      // Try to find the main chart container (often has a specific ID or class structure)
      // If we can't find a specific container, we fall back to full page
      const chartContainer = await page.$('div[id^="tradingview_"]');
      const canvas = await page.$('canvas');

      let buffer: Uint8Array;

      if (chartContainer) {
        // Capture specifically the chart container
        buffer = await chartContainer.screenshot({ type: 'png' });
      } else if (canvas) {
        // Fallback to canvas (might miss axes if they are separate DOM elements)
        // Usually better to find the parent of canvas
        const canvasParent = await canvas.evaluateHandle(el => el.parentElement);
        const parentElement = canvasParent.asElement();
        if (parentElement) {
          buffer = await parentElement.screenshot({ type: 'png' });
        } else {
          buffer = await page.screenshot({ type: 'png', fullPage: false });
        }
      } else {
        buffer = await page.screenshot({ type: 'png', fullPage: false });
      }

      // 5. If running locally (development), save the file to disk for debugging
      if (process.env.NODE_ENV === 'development') {
        try {
          const debugDir = path.join(process.cwd(), 'src', 'app', 'charts', 'debug-screenshots');
          if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
          }
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filePath = path.join(debugDir, `${tokenAddress}-${timestamp}.png`);
          fs.writeFileSync(filePath, buffer);
          console.log(`Debug screenshot saved to: ${filePath}`);
        } catch (saveError) {
          console.error("Failed to save debug screenshot:", saveError);
        }
      }

      const base64Image = `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`;

      return NextResponse.json({
        success: true,
        imageBase64: base64Image,
        message: "Chart captured"
      });

    } finally {
      await browser.close();
    }

  } catch (error) {
    console.error("Screenshot error:", error);
    return NextResponse.json({ error: "Failed to capture chart" }, { status: 500 });
  }
}
