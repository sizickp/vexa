import { Page } from "playwright";
import { log, callJoiningCallback } from "../_host";
import { BotConfig } from "../_host";
import { AdmissionError } from "../shared/admission";
import { attachTerminalConsoleWatch, findBodyText, isAdmitted } from "./admission";
import {
  telemostHosts,
  telemostLoginHosts,
  telemostLoginTestIds,
  telemostNameInputSelector,
  telemostJoinButtonSelectors,
  telemostJoinButtonTexts,
  telemostContinueInBrowserSelectors,
  telemostContinueInBrowserTexts,
  telemostDismissSelectors,
  telemostDismissTexts,
  telemostPrejoinMuteSelectors,
  telemostNotFoundTexts,
  telemostNeedLoginTexts,
} from "./selectors";

// NOTE vs the other platforms: Telemost is a hosted service (no self-hosted
// deployments), and a meeting is addressed by a numeric id under `/j/`. The
// page exposes no runtime API, so the whole join is driven through the DOM.
// Per-speaker capture and recording are HOST concerns and stay outside this brick.

// The app rewrites a loaded meeting's path to `/@/j/<id>`; a link copied from the address bar
// carries that form, so it is accepted alongside `/j/<id>`.
const TELEMOST_PATH = /^(?:\/@)?\/j\/(\d+)\/?$/;

/** True when `host` is one of the public Telemost deployments. */
export function isTelemostHost(host: string): boolean {
  return telemostHosts.includes(host.toLowerCase());
}

/**
 * Build the Telemost meeting URL the bot navigates to.
 *
 * Input:  https://telemost.yandex.ru/j/12345678901234   (any public Telemost host)
 * Output: https://telemost.yandex.ru/j/12345678901234
 *
 * The host is preserved (a Yandex 360 link stays on the 360 host), query and
 * hash are dropped — Telemost reads no join overrides from the URL, so the
 * canonical form is just origin + `/j/<id>`. Anything that is not a Telemost
 * host or not a `/j/<digits>` path throws: there is nothing to join.
 */
export function buildTelemostMeetingUrl(meetingUrl: string): string {
  let url: URL;
  try {
    url = new URL(meetingUrl);
  } catch (err: any) {
    throw new Error(`Invalid Telemost meeting URL: ${meetingUrl} — ${err.message}`);
  }
  if (!isTelemostHost(url.hostname)) {
    throw new Error(`Not a Telemost host: ${url.hostname} (${meetingUrl})`);
  }
  const m = TELEMOST_PATH.exec(url.pathname);
  if (!m) {
    throw new Error(`Cannot extract meeting id from Telemost URL (expected /j/<digits>): ${meetingUrl}`);
  }
  return `https://${url.hostname.toLowerCase()}/j/${m[1]}`;
}

/** Click the first VISIBLE element matching one of `selectors`, DOM-direct. Returns the selector. */
async function clickFirstVisible(page: Page, selectors: string[]): Promise<string | null> {
  return await page.evaluate((sels: string[]) => {
    for (const sel of sels) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.offsetParent !== null && !(el as HTMLButtonElement).disabled) {
        el.click();
        return sel;
      }
    }
    return null;
  }, selectors).catch(() => null);
}

/** Click the button/link whose text matches one of `phrases` (case-insensitive), DOM-direct.
 *  An EXACT text match wins over a substring match, so a generic phrase ("join") never lands on
 *  a longer control that merely contains it. Sign-in controls are never candidates — a guest
 *  bot that clicks "Войти" ends up on the Yandex ID page. Returns the matched text, or null. */
async function clickByText(page: Page, phrases: string[]): Promise<string | null> {
  return await page.evaluate(({ ps, loginIds }: { ps: string[]; loginIds: string[] }) => {
    const candidates = (Array.from(
      document.querySelectorAll('button, a, [role="button"]'),
    ) as HTMLElement[]).filter((el) =>
      !(el as HTMLButtonElement).disabled
      && el.offsetParent !== null
      && !loginIds.includes(el.getAttribute("data-testid") || "")
      && (el.textContent || "").trim().toLowerCase() !== "войти");
    const textOf = (el: HTMLElement) => (el.textContent || "").trim().toLowerCase();
    const pick =
      candidates.find((el) => ps.includes(textOf(el))) ??
      candidates.find((el) => { const t = textOf(el); return !!t && ps.some((p) => t.includes(p)); });
    if (!pick) return null;
    pick.click();
    return textOf(pick);
  }, { ps: phrases, loginIds: telemostLoginTestIds }).catch(() => null);
}

/** A pre-admission dead end — the sign-in wall or a meeting that does not exist. Both are
 *  permanent host-side verdicts: a retried join would land on the same page. */
async function assertJoinable(page: Page): Promise<void> {
  let host = "";
  try { host = new URL(page.url()).hostname.toLowerCase(); } catch { /* keep "" */ }
  if (telemostLoginHosts.includes(host)) {
    throw new AdmissionError("denial", `[Telemost] Redirected to Yandex sign-in (${page.url()}) — this meeting does not admit guests`);
  }
  const needLogin = await findBodyText(page, telemostNeedLoginTexts);
  if (needLogin) {
    throw new AdmissionError("denial", `[Telemost] Meeting requires a Yandex sign-in (matched: "${needLogin}")`);
  }
  const notFound = await findBodyText(page, telemostNotFoundTexts);
  if (notFound) {
    throw new AdmissionError("denial", `[Telemost] Meeting not found (matched: "${notFound}")`);
  }
}

/**
 * Walk the screens in front of the pre-join form: announcement modals and the
 * app-or-browser choice. Returns once the name field is up, the call is live,
 * or the window runs out (admission owns the wait from there).
 */
async function reachPrejoin(page: Page): Promise<"prejoin" | "admitted" | "unknown"> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await assertJoinable(page);

    const dismissed = await clickFirstVisible(page, telemostDismissSelectors)
      ?? await clickByText(page, telemostDismissTexts);
    if (dismissed) log(`[Telemost] Dismissed an announcement (${dismissed})`);

    const stayed = await clickFirstVisible(page, telemostContinueInBrowserSelectors)
      ?? await clickByText(page, telemostContinueInBrowserTexts);
    if (stayed) {
      log(`[Telemost] App-or-browser choice — stayed in browser (${stayed})`);
      await page.waitForTimeout(1500);
      continue;
    }

    const prejoinUp = await page.locator(telemostNameInputSelector).first()
      .isVisible({ timeout: 300 }).catch(() => false);
    if (prejoinUp) return "prejoin";
    if (await isAdmitted(page)) return "admitted";
    await page.waitForTimeout(700);
  }
  return "unknown";
}

export async function joinTelemostMeeting(
  page: Page,
  meetingUrl: string,
  botName: string,
  botConfig: BotConfig,
): Promise<void> {
  if (!page) throw new Error("[Telemost] Page is required for Telemost join");

  // Latch media-engine disconnect codes from the page console BEFORE navigation, so a kick or a
  // closed room is recognised even when the DOM has not rendered it yet.
  attachTerminalConsoleWatch(page);

  const navUrl = buildTelemostMeetingUrl(meetingUrl);
  log(`[Telemost] Navigating to: ${navUrl}`);
  await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);

  await callJoiningCallback(botConfig);

  const reached = await reachPrejoin(page);
  if (reached === "admitted") {
    log("[Telemost] No pre-join screen — call already live");
    return;
  }
  if (reached === "unknown") {
    // A signed-in context skips the guest name screen; otherwise the app may still be booting.
    log("[Telemost] No pre-join name field detected — proceeding to admission checks");
    return;
  }

  // Fill the display name with REAL keyboard events — a React-controlled input only
  // enables the join button on genuine input events, not on a synthetic value-set.
  const nameField = page.locator(telemostNameInputSelector).first();
  const current = await nameField.inputValue().catch(() => "");
  if (current !== botName) {
    await nameField.click({ timeout: 5000 }).catch(() => {});
    await nameField.fill("");
    await page.keyboard.type(botName, { delay: 30 });
  }
  log(`[Telemost] Name entered: "${botName}"`);

  // Receive-only bot: switch the pre-join mic and camera off (each toggle absent when the
  // browser exposes no such device).
  for (const sel of telemostPrejoinMuteSelectors) {
    const muted = await clickFirstVisible(page, [sel]);
    if (muted) log(`[Telemost] Pre-join toggle off (${muted})`);
  }

  // The join button enables once the name is non-empty; poll the click briefly.
  const deadline = Date.now() + 10000;
  let clicked: string | null = null;
  while (!clicked && Date.now() < deadline) {
    clicked = await clickFirstVisible(page, telemostJoinButtonSelectors)
      ?? await clickByText(page, telemostJoinButtonTexts);
    if (!clicked) await page.waitForTimeout(500);
  }
  if (!clicked) {
    await nameField.press("Enter").catch(() => {});
    log("[Telemost] Join button not found — submitted the name with Enter");
  } else {
    log(`[Telemost] Join clicked (${clicked}) — waiting for the call to load...`);
  }

  await page.waitForTimeout(2000);
  const banner = await clickByText(page, telemostDismissTexts);
  if (banner) log(`[Telemost] Dismissed an in-call banner ("${banner}")`);
}
