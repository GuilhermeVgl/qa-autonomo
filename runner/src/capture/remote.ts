import { chromium, type Page } from "playwright";
import type { ControlPlaneClient } from "../protocol/client.js";
import type { CaptureInput, CaptureSession } from "../protocol/schemas.js";
import { CAPTURE_VIEWPORT, mouseButton, specialKey, toViewport } from "./input.js";

const FRAME_INTERVAL_MS = 400;

/**
 * Drives a remote browser the person uses to log in: opens the start URL, streams the screen to the UI as JPEG frames,
 * applies the clicks/keys that come back, and on "finish" hands the authenticated storageState to the control plane. The
 * browser has no host scope on purpose — the login may go through the identity provider's own domain.
 */
export async function runCapture(client: ControlPlaneClient, session: CaptureSession): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    // A realistic User-Agent and locale: headless Chromium reports "HeadlessChrome", which identity providers
    // (Microsoft/Entra, Okta) often reject by serving a blank page. Strip the headless marker so the login renders.
    const userAgent = (await browser.newContext().then(async (c) => {
      const ua = await c.newPage().then((p) => p.evaluate(() => navigator.userAgent));
      await c.close();
      return ua.replace(/HeadlessChrome/i, "Chrome");
    })).trim();
    const context = await browser.newContext({ viewport: CAPTURE_VIEWPORT, deviceScaleFactor: 1, userAgent, locale: "pt-BR" });
    const page = await context.newPage();

    let sending = false;
    const sendFrame = async (): Promise<void> => {
      if (sending) return; // never let a slow screenshot pile up on the next tick
      sending = true;
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 55, timeout: 5000 });
        await client.captureFrame(session.id, buf);
      } catch {
        // a screenshot taken mid-navigation can fail or time out; the next tick retries
      } finally {
        sending = false;
      }
    };
    // Stream the screen right away, then navigate in the background: the person sees the browser load, not a blank wait.
    const timer = setInterval(() => void sendFrame(), FRAME_INTERVAL_MS);
    void page.goto(session.start_url, { waitUntil: "commit", timeout: 30_000 }).catch(() => undefined);
    try {
      for (;;) {
        const { events, finish, cancel } = await client.capturePoll(session.id, 15_000);
        for (const e of events) await applyInput(page, e);
        if (events.length > 0) await sendFrame();
        if (cancel) return;
        if (finish) {
          const state = await context.storageState();
          await client.captureResult(session.id, JSON.stringify(state));
          return;
        }
      }
    } finally {
      clearInterval(timer);
    }
  } catch {
    await client.captureFailed(session.id).catch(() => undefined);
  } finally {
    await browser.close();
  }
}

async function applyInput(page: Page, e: CaptureInput): Promise<void> {
  const { x, y } = toViewport(e);
  try {
    switch (e.type) {
      case "move":
        await page.mouse.move(x, y);
        break;
      case "click":
        await page.mouse.click(x, y, { button: mouseButton(e.button) });
        break;
      case "wheel":
        await page.mouse.wheel(0, e.dy ?? 0);
        break;
      case "text":
        if (e.text) await page.keyboard.insertText(e.text);
        break;
      case "key": {
        const key = specialKey(e.key);
        if (key) await page.keyboard.press(key);
        break;
      }
    }
  } catch {
    // the page may navigate under an input; ignore and let the next frame reflect the new state
  }
}
