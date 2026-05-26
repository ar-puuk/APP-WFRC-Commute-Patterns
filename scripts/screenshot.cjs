// Playwright script: capture light + dark screenshots of the app
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const url = 'http://localhost:5174/APP-WFRC-Commute-Patterns/';

  async function shoot(theme, outPath) {
    const ctx  = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const page = await ctx.newPage();

    await page.goto(url, { waitUntil: 'networkidle' });

    // Wait for the loading overlay to disappear (DuckDB + parquet)
    await page.waitForSelector('.sidebar-loading', { state: 'detached', timeout: 60000 }).catch(() => {});
    // Extra settle time for map tiles + flow arcs
    await page.waitForTimeout(3500);

    if (theme === 'dark') {
      // Click the theme toggle button
      const toggle = page.locator('#theme-toggle');
      await toggle.click();
      await page.waitForTimeout(1500);
    }

    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`Saved ${outPath}`);
    await ctx.close();
  }

  await shoot('light', 'docs/screenshot-light.png');
  await shoot('dark',  'docs/screenshot-dark.png');

  await browser.close();
})();
