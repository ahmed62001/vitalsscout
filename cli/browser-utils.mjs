import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CANDIDATE_CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/**
 * Locate a locally installed Chromium/Chrome binary.
 * @returns {string}
 */
export function findChromeExecutable() {
  for (const candidate of CANDIDATE_CHROME_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'No local Chrome or Chromium executable found. Set CHROME_PATH or install Google Chrome / Chromium.'
  );
}

/**
 * Launch headless Chrome for Lighthouse and Puppeteer audits.
 * @returns {Promise<{browser: import('puppeteer-core').Browser, port: number, executablePath: string}>}
 */
export async function launchHeadlessBrowser() {
  const executablePath = findChromeExecutable();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const wsUrl = new URL(browser.wsEndpoint());
  const port = Number(wsUrl.port);
  if (!Number.isInteger(port) || port <= 0) {
    await browser.close();
    throw new Error(`Invalid browser debugging port from wsEndpoint: ${browser.wsEndpoint()}`);
  }

  return { browser, port, executablePath };
}
