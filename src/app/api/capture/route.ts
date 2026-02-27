import { NextResponse } from 'next/server';
import puppeteer from 'puppeteer';

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
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();

      // 2. Go to URL and Wait
      // 'networkidle0' might be too slow for GMGN if it has streaming data. 
      // 'domcontentloaded' + a fixed wait is often more robust for charts.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait extra time for the chart canvas to actually render content
      await new Promise(r => setTimeout(r, 3000));

      // 3. Remove Popups/Overlays
      await page.addStyleTag({
        content: `
          header, footer, .popup, nav, .cookie-banner { display: none !important; }
          /* Hide trading buttons overlay if present to get clean chart */
          button, .trade-panel { opacity: 0; } 
        `
      });

      // 4. Screenshot
      // We'll capture the full page for now as finding the exact dynamic class might be brittle
      // or we can try to target 'canvas' if we know it's there.
      // Let's try to target the main container usually used in trading view charts if possible,
      // otherwise full page cropped is fine.

      // Attempt to find a canvas or chart container
      const chartElement = await page.$('canvas');

      let buffer: Uint8Array;
      if (chartElement) {
        // Capture the chart area specifically if possible, 
        // but often charts are layers. Safest is viewport capture or page capture.
        // Let's capture the page but crop it if needed? 
        // For simplicity: Capture screenshot of the page.
        buffer = await page.screenshot({ type: 'png', fullPage: false });
      } else {
        buffer = await page.screenshot({ type: 'png', fullPage: false });
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
