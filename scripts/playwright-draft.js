#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const DATA_DIR = path.resolve('.linkedin-outreach-data');
const LEDGER_PATH = path.join(DATA_DIR, 'ledger.json');
const RESULTS_CSV_PATH = path.join(DATA_DIR, 'results.csv');
const LOCK_PATH = path.join(DATA_DIR, 'send.lock');
const DEFAULT_DAILY_CAP = 5;
const MAX_FAILURES_BEFORE_HALT = 3;
const DEFAULT_ACTIVE_HOURS = '09:00-18:00';
const DEFAULT_DELAY_MIN_SECONDS = 60;
const DEFAULT_DELAY_MAX_SECONDS = 180;

const DEFAULT_MESSAGE = `Hi Alison,

Hope you're doing well. I wanted to reach out and reconnect.`;

main().catch((err) => {
  console.error('[playwright-draft] fatal:', err?.message || err);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDataDir();

  if (args['reset-halt']) {
    const ledger = loadLedger();
    ledger.halted = null;
    ledger.consecutiveFailures = 0;
    saveLedger(ledger);
    console.log('[playwright-draft] safety halt reset');
    return;
  }

  if (args.status) {
    printSafetyStatus(loadLedger());
    return;
  }

  const rawProfileUrl = args.url || args.u || process.env.LINKEDIN_URL;
  const profileUrl = rawProfileUrl ? normalizeProfileUrl(rawProfileUrl) : '';
  const message = readMessage(args);
  const userDataDir = path.resolve(args.profile || process.env.LINKEDIN_PLAYWRIGHT_PROFILE || '.playwright-linkedin-profile');
  const shouldSend = args.send === true || process.env.LINKEDIN_OUTREACH_SEND === '1';
  const shouldClose = args.close === true || process.env.LINKEDIN_OUTREACH_CLOSE === '1';
  const safety = buildSafetyOptions(args);
  let sendLock = null;
  let sendRecorded = false;

  if (!profileUrl) {
    throw new Error('Missing --url. Example: npm run draft:linkedin -- --url "https://www.linkedin.com/in/..." --message "Hi ..."');
  }
  if (!/^https:\/\/www\.linkedin\.com\/in\//.test(profileUrl)) {
    throw new Error('Expected a direct LinkedIn profile URL like https://www.linkedin.com/in/<handle>/');
  }
  if (!message.trim()) {
    throw new Error('Message is empty.');
  }

  let ledger = loadLedger();
  if (shouldSend) {
    assertCanSend({ ledger, profileUrl, message, safety });
    sendLock = acquireSendLock();
  }

  console.log('[playwright-draft] launching browser');
  console.log('[playwright-draft] profile:', userDataDir);
  if (shouldSend) {
    console.log('[playwright-draft] safety:', {
      dailyCap: safety.dailyCap,
      activeHours: safety.activeHours,
      delaySeconds: [safety.delayMinSeconds, safety.delayMaxSeconds],
      uniqueNewProfilesToday: countUniqueSendsToday(ledger),
    });
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    locale: 'en-US',
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15_000);

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    if (await isLoginOrCheckpoint(page)) {
      if (shouldClose) {
        throw new Error('LinkedIn wants login/checkpoint. Run npm run draft:linkedin manually once, complete login in the Playwright browser, then retry from the UI.');
      }
      console.log('[playwright-draft] LinkedIn wants login/checkpoint. Log in in the opened browser, then press Enter here.');
      await waitForEnter();
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    }

    if (shouldSend) await assertNoLinkedInWarning(page, 'before drafting');

    await humanPause(1200, 2200);
    await page.mouse.wheel(0, randomInt(180, 420));
    await humanPause(400, 900);
    await page.mouse.wheel(0, -randomInt(100, 260));
    await humanPause(400, 900);

    const ownerName = await detectProfileOwner(page);
    console.log('[playwright-draft] profile owner:', ownerName || '(unknown)');

    await dismissOpenMessagingOverlays(page);

    const messageButton = await findProfileMessageButton(page, ownerName);
    if (!messageButton) {
      await logMessageButtonDiagnostics(page);
      throw new Error('Could not find a safe profile Message button.');
    }

    console.log('[playwright-draft] clicking Message');
    await messageButton.scrollIntoViewIfNeeded();
    await humanPause(250, 600);
    await messageButton.click({ delay: randomInt(40, 120) });

    const composer = await waitForComposer(page, 15_000, ownerName);
    if (!composer) {
      await logComposerDiagnostics(page);
      throw new Error(`Message button clicked, but no composer for ${ownerName || 'the profile'} appeared.`);
    }

    console.log('[playwright-draft] composer found for profile; drafting message');
    await composer.click({ delay: randomInt(40, 120) });
    await clearComposer(page, composer);
    await humanPause(200, 400);
    await page.keyboard.type(message, { delay: randomInt(35, 90) });

    await humanPause(500, 900);
    const actual = await readComposerText(composer);
    const expectedHead = message.trim().slice(0, 12);
    if (!actual.includes(expectedHead)) {
      throw new Error(`Draft verification failed. Expected head "${expectedHead}", saw "${actual.slice(0, 40)}"`);
    }

    console.log('[playwright-draft] draft inserted and verified');

    if (shouldSend) {
      const sendButton = await waitForSendButton(page, composer, 8_000);
      if (!sendButton) throw new Error('Send requested, but no enabled Send button was found.');
      await assertNoLinkedInWarning(page, 'before send');
      await applyPreSendDelay(safety);
      console.log('[playwright-draft] sending message');
      await humanPause(500, 1200);
      await sendButton.click({ delay: randomInt(40, 120) });
      const sent = await waitForSendConfirmation(composer, expectedHead, 10_000);
      if (!sent.ok) {
        throw new Error(sent.reason);
      }
      await assertNoLinkedInWarning(page, 'after send');
      ledger = recordSendSuccess({
        ledger: loadLedger(),
        profileUrl,
        ownerName,
        message,
      });
      sendRecorded = true;
      console.log('[playwright-draft] message sent and verified');
    } else {
      console.log('[playwright-draft] stopped before Send. Review the draft in LinkedIn and send manually.');
    }
  } catch (err) {
    if (shouldSend && !sendRecorded) {
      recordSendFailure({
        ledger: loadLedger(),
        profileUrl,
        message,
        error: err?.message || String(err),
      });
    }
    throw err;
  } finally {
    if (sendLock) releaseSendLock(sendLock);
    if (shouldClose) {
      await context.close();
      console.log('[playwright-draft] browser closed');
    } else {
      console.log('[playwright-draft] leaving browser open for inspection. Press Ctrl+C in this terminal when done.');
    }
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function readMessage(args) {
  if (args.messageFile || args['message-file']) {
    const file = path.resolve(args.messageFile || args['message-file']);
    return fs.readFileSync(file, 'utf8');
  }
  return args.message || args.m || process.env.LINKEDIN_MESSAGE || DEFAULT_MESSAGE;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeProfileUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.search = '';
  parsed.protocol = 'https:';
  parsed.hostname = 'www.linkedin.com';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function buildSafetyOptions(args) {
  const dailyCap = readInteger(args['daily-cap'] || process.env.LINKEDIN_DAILY_CAP, DEFAULT_DAILY_CAP);
  const delayMinSeconds = readInteger(args['min-delay'] || process.env.LINKEDIN_MIN_DELAY_SECONDS, DEFAULT_DELAY_MIN_SECONDS);
  const delayMaxSeconds = readInteger(args['max-delay'] || process.env.LINKEDIN_MAX_DELAY_SECONDS, DEFAULT_DELAY_MAX_SECONDS);

  if (dailyCap < 1 || dailyCap > 10) {
    throw new Error('Daily cap must be between 1 and 10. Safer default is 5.');
  }
  if (delayMinSeconds < 0 || delayMaxSeconds < delayMinSeconds) {
    throw new Error('Invalid delay range. Use --min-delay N --max-delay M with M >= N.');
  }

  return {
    dailyCap,
    activeHours: String(args['active-hours'] || process.env.LINKEDIN_ACTIVE_HOURS || DEFAULT_ACTIVE_HOURS),
    delayMinSeconds,
    delayMaxSeconds,
    allowRepeat: args['allow-repeat'] === true || process.env.LINKEDIN_ALLOW_REPEAT === '1',
    allowDuplicateMessage: args['allow-duplicate-message'] === true || process.env.LINKEDIN_ALLOW_DUPLICATE_MESSAGE === '1',
    ignoreActiveHours: args['ignore-active-hours'] === true || process.env.LINKEDIN_IGNORE_ACTIVE_HOURS === '1',
  };
}

function readInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) {
    return { version: 1, sends: [], failures: [], consecutiveFailures: 0, halted: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return {
      version: 1,
      sends: Array.isArray(parsed.sends) ? parsed.sends : [],
      failures: Array.isArray(parsed.failures) ? parsed.failures : [],
      consecutiveFailures: parsed.consecutiveFailures || 0,
      halted: parsed.halted || null,
    };
  } catch (err) {
    throw new Error(`Could not read safety ledger at ${LEDGER_PATH}: ${err.message}`);
  }
}

function saveLedger(ledger) {
  ensureDataDir();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function assertCanSend({ ledger, profileUrl, message, safety }) {
  if (ledger.halted) {
    throw new Error(`Safety halt is active: ${ledger.halted.reason}. Run npm run send:linkedin -- --reset-halt after reviewing the issue.`);
  }

  if (!safety.ignoreActiveHours && !isWithinActiveHours(safety.activeHours)) {
    throw new Error(`Outside active send hours (${safety.activeHours}). Override with --ignore-active-hours if you really want to send now.`);
  }

  const sentToProfile = ledger.sends.find((entry) => entry.profileUrl === profileUrl);
  if (sentToProfile && !safety.allowRepeat) {
    throw new Error(`Already sent to this profile on ${sentToProfile.sentAt}. Use --allow-repeat only if this is intentional.`);
  }

  const todayCount = countUniqueSendsToday(ledger);
  if (todayCount >= safety.dailyCap) {
    throw new Error(`Daily new-profile cap reached (${todayCount}/${safety.dailyCap}).`);
  }

  const hash = hashMessage(message);
  const duplicate = ledger.sends.find((entry) => entry.messageHash === hash && daysBetween(entry.sentAt, new Date().toISOString()) <= 7);
  if (duplicate && !safety.allowDuplicateMessage) {
    throw new Error(`Exact same message was already sent recently to ${duplicate.profileUrl}. Use --allow-duplicate-message only if intentional.`);
  }
}

function countUniqueSendsToday(ledger) {
  const today = localDateKey(new Date());
  const profiles = new Set();
  for (const send of ledger.sends) {
    if (send.localDate === today) profiles.add(send.profileUrl);
  }
  return profiles.size;
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isWithinActiveHours(activeHours) {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(activeHours);
  if (!match) throw new Error(`Invalid active hours "${activeHours}". Expected HH:MM-HH:MM.`);
  const [, sh, sm, eh, em] = match.map(Number);
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start <= end) return minutes >= start && minutes <= end;
  return minutes >= start || minutes <= end;
}

function hashMessage(message) {
  return crypto.createHash('sha256').update(normalizeMessage(message)).digest('hex');
}

function normalizeMessage(message) {
  return String(message).trim().replace(/\s+/g, ' ').toLowerCase();
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  return Math.abs(b - a) / 86_400_000;
}

function acquireSendLock() {
  ensureDataDir();
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2));
    return fd;
  } catch (err) {
    if (err.code === 'EEXIST') {
      const staleReason = getStaleLockReason();
      if (staleReason) {
        console.warn(`[playwright-draft] removing stale send lock: ${staleReason}`);
        try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
        return acquireSendLock();
      }
      throw new Error(`Another send appears to be running (${LOCK_PATH}). Remove the lock only if you are sure it is stale.`);
    }
    throw err;
  }
}

function getStaleLockReason() {
  let raw = '';
  try {
    raw = fs.readFileSync(LOCK_PATH, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? 'lock disappeared before acquisition' : '';
  }

  let lock = null;
  try {
    lock = JSON.parse(raw);
  } catch (_) {
    return 'lock file is not valid JSON';
  }

  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return 'lock file is missing a valid pid';
  if (!isProcessRunning(pid)) return `pid ${pid} is no longer running`;
  return '';
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function releaseSendLock(fd) {
  try { fs.closeSync(fd); } catch (_) {}
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}

async function applyPreSendDelay(safety) {
  const seconds = randomInt(safety.delayMinSeconds, safety.delayMaxSeconds);
  if (seconds <= 0) return;
  console.log(`[playwright-draft] safety delay before send: ${seconds}s`);
  await humanPause(seconds * 1000, seconds * 1000);
}

function recordSendSuccess({ ledger, profileUrl, ownerName, message }) {
  const now = new Date();
  const entry = {
    status: 'sent',
    sentAt: now.toISOString(),
    localDate: localDateKey(now),
    profileUrl,
    ownerName,
    messageHash: hashMessage(message),
    messageLength: message.length,
  };
  ledger.sends.push(entry);
  ledger.consecutiveFailures = 0;
  ledger.halted = null;
  saveLedger(ledger);
  appendResultCsv({ ...entry, error: '' });
  return ledger;
}

function recordSendFailure({ ledger, profileUrl, message, error }) {
  const now = new Date();
  const entry = {
    status: 'failed',
    failedAt: now.toISOString(),
    localDate: localDateKey(now),
    profileUrl,
    messageHash: hashMessage(message),
    messageLength: message.length,
    error,
  };
  ledger.failures.push(entry);
  ledger.consecutiveFailures = (ledger.consecutiveFailures || 0) + 1;
  if (ledger.consecutiveFailures >= MAX_FAILURES_BEFORE_HALT) {
    ledger.halted = {
      reason: `${MAX_FAILURES_BEFORE_HALT} consecutive send failures`,
      when: now.toISOString(),
    };
  }
  saveLedger(ledger);
  appendResultCsv(entry);
}

function appendResultCsv(entry) {
  ensureDataDir();
  const exists = fs.existsSync(RESULTS_CSV_PATH);
  const headers = ['status', 'localDate', 'sentAt', 'failedAt', 'profileUrl', 'ownerName', 'messageLength', 'messageHash', 'error'];
  const row = headers.map((key) => csvEscape(entry[key] || '')).join(',');
  if (!exists) fs.writeFileSync(RESULTS_CSV_PATH, headers.join(',') + '\n');
  fs.appendFileSync(RESULTS_CSV_PATH, row + '\n');
}

function csvEscape(value) {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function printSafetyStatus(ledger) {
  const todayCount = countUniqueSendsToday(ledger);
  console.log('[playwright-draft] safety status');
  console.log(`  today unique new profiles: ${todayCount}/${DEFAULT_DAILY_CAP} default cap`);
  console.log(`  total sent profiles: ${new Set(ledger.sends.map((entry) => entry.profileUrl)).size}`);
  console.log(`  consecutive failures: ${ledger.consecutiveFailures || 0}/${MAX_FAILURES_BEFORE_HALT}`);
  console.log(`  halted: ${ledger.halted ? `${ledger.halted.reason} (${ledger.halted.when})` : 'no'}`);
  console.log(`  ledger: ${LEDGER_PATH}`);
  console.log(`  results: ${RESULTS_CSV_PATH}`);
}

async function isLoginOrCheckpoint(page) {
  const url = page.url();
  if (/\/(login|checkpoint|authwall|uas\/login)/.test(url)) return true;
  const password = await page.locator('input[type="password"]').count().catch(() => 0);
  return password > 0;
}

async function assertNoLinkedInWarning(page, phase) {
  const warning = await detectLinkedInWarning(page);
  if (!warning.ok) {
    const ledger = loadLedger();
    ledger.halted = {
      reason: `LinkedIn warning detected ${phase}: ${warning.reason}`,
      when: new Date().toISOString(),
    };
    saveLedger(ledger);
    throw new Error(`LinkedIn warning detected ${phase}: ${warning.reason}`);
  }
}

async function detectLinkedInWarning(page) {
  const url = page.url();
  if (/\/checkpoint|\/authwall|\/uas\/login|\/login/.test(url)) {
    return { ok: false, reason: `checkpoint/login URL: ${url}` };
  }

  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const compact = bodyText.replace(/\s+/g, ' ').toLowerCase();
  const patterns = [
    'unusual activity',
    'temporarily restricted',
    'account has been restricted',
    'verify your identity',
    'security check',
    'automated tools',
    'automation tools',
    'commercial use limit',
    'we noticed some unusual',
    'your account is temporarily',
  ];

  const hit = patterns.find((pattern) => compact.includes(pattern));
  if (hit) return { ok: false, reason: `page text contains "${hit}"` };
  return { ok: true };
}

async function detectProfileOwner(page) {
  const h1 = page.locator('main h1, section h1').first();
  const text = await h1.textContent({ timeout: 5000 }).catch(() => '');
  if (text && text.trim().length < 100) return text.trim();
  const title = await page.title().catch(() => '');
  if (title.includes('|')) return title.split('|')[0].trim();
  return '';
}

async function findProfileMessageButton(page, ownerName) {
  const ownerLow = (ownerName || '').toLowerCase();
  const ownerParts = ownerLow.split(/\s+/).filter((p) => p.length > 1);
  const buttons = page.locator('button:visible');
  const count = await buttons.count();
  const candidates = [];

  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    const info = await button.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').trim().replace(/\s+/g, ' '),
        ariaLabel: (el.getAttribute('aria-label') || '').trim(),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        inAside: !!el.closest('aside'),
        inGlobalNav: !!el.closest('.global-nav, #global-nav, [class*="global-nav"]'),
        inMsgOverlay: !!el.closest('[class*="msg-overlay"]'),
        inTopCard: !!el.closest('.pv-top-card, .pv-top-card-v2-ctas, .pvs-profile-actions, .pv-text-details__left-panel, [class*="profile-actions"], [class*="top-card"]'),
      };
    }).catch(() => null);

    if (!info || info.disabled) continue;
    const labelLow = info.ariaLabel.toLowerCase();
    const textLow = info.text.toLowerCase();
    if (labelLow.includes('premium') || labelLow.includes('inmail') || labelLow.includes('in-mail')) continue;
    if (info.inGlobalNav || info.inMsgOverlay || info.rect.y < 60 || info.rect.width < 20 || info.rect.height < 20) continue;
    if (!/^message\b/i.test(info.ariaLabel) && textLow !== 'message') continue;

    if (ownerLow && /^message\s+\S+/i.test(info.ariaLabel)) {
      const target = info.ariaLabel.replace(/^message\s+/i, '').trim().toLowerCase();
      const looksLikeOwner =
        target.includes(ownerLow) ||
        ownerLow.includes(target) ||
        (ownerParts.length > 0 && ownerParts.every((part) => target.includes(part)));
      if (!looksLikeOwner) continue;
    }

    candidates.push({ index: i, info });
  }

  candidates.sort((a, b) => {
    if (a.info.inTopCard !== b.info.inTopCard) return a.info.inTopCard ? -1 : 1;
    if (a.info.inAside !== b.info.inAside) return a.info.inAside ? 1 : -1;
    return a.info.rect.y - b.info.rect.y;
  });

  if (candidates.length) {
    console.log('[playwright-draft] message candidates:', candidates.map((c) => c.info));
    return buttons.nth(candidates[0].index);
  }

  return null;
}

async function dismissOpenMessagingOverlays(page) {
  let closed = 0;
  const closePatterns = [/close/i, /dismiss/i];
  const minimizePatterns = [/minimi[sz]e/i, /collapse/i];

  for (const patterns of [closePatterns, minimizePatterns]) {
    for (let pass = 0; pass < 4; pass++) {
      const buttons = page.locator('[class*="msg-overlay"] button:visible, [class*="msg-conversation"] button:visible');
      const count = await buttons.count().catch(() => 0);
      let clicked = false;

      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        const info = await button.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return {
            label: [
              el.getAttribute('aria-label') || '',
              el.getAttribute('title') || '',
              el.textContent || '',
            ].join(' ').trim(),
            disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
            visible: rect.width > 0 && rect.height > 0,
          };
        }).catch(() => null);

        if (!info || info.disabled || !info.visible) continue;
        if (!patterns.some((pattern) => pattern.test(info.label))) continue;
        if (/send/i.test(info.label)) continue;

        await button.click({ delay: randomInt(30, 90) }).catch(() => {});
        await page.waitForTimeout(250);
        closed += 1;
        clicked = true;
        break;
      }

      if (!clicked) break;
    }
  }

  if (closed > 0) {
    console.log(`[playwright-draft] closed/minimized ${closed} existing messaging overlay control(s)`);
    await page.waitForTimeout(500);
  }
}

async function waitForComposer(page, timeoutMs, ownerName = '') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const composer = await findComposer(page, ownerName);
    if (composer) return composer;
    await page.waitForTimeout(300);
  }
  return null;
}

async function findComposer(page, ownerName = '') {
  const selectors = [
    '.msg-form__contenteditable[contenteditable="true"]',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    '.msg-overlay-conversation-bubble div[contenteditable="true"]',
    '.msg-overlay-base-conversation-bubble div[contenteditable="true"]',
    'form div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[role="textbox"][aria-label*="message" i]',
    'div[contenteditable="true"][aria-label*="message" i]',
    '[role="dialog"] div[contenteditable="true"]',
    '[class*="msg-"] div[contenteditable="true"]',
  ];

  for (const selector of selectors) {
    const locators = page.locator(selector);
    const count = await locators.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const locator = locators.nth(i);
      if (!(await locator.isVisible().catch(() => false))) continue;
      if (!ownerName || await composerBelongsToOwner(locator, ownerName)) return locator;
    }
  }

  const generic = page.locator('div[contenteditable="true"]:visible, [role="textbox"]:visible');
  const count = await generic.count().catch(() => 0);
  if (count === 1) {
    const only = generic.first();
    if (!ownerName || await composerBelongsToOwner(only, ownerName)) return only;
  }

  for (let i = 0; i < count; i++) {
    const candidate = generic.nth(i);
    const likely = await candidate.evaluate((el) =>
      !!el.closest('[role="dialog"], form, [class*="msg"], [class*="message"], [class*="compose"]')
    ).catch(() => false);
    if (likely && (!ownerName || await composerBelongsToOwner(candidate, ownerName))) return candidate;
  }

  return null;
}

async function composerBelongsToOwner(composer, ownerName) {
  return composer.evaluate((el, name) => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const owner = normalize(name);
    const parts = owner.split(' ').filter((part) => part.length > 1);
    if (!owner || parts.length === 0) return true;

    let node = el;
    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      const text = normalize([
        node.textContent || '',
        node.getAttribute?.('aria-label') || '',
        node.getAttribute?.('title') || '',
      ].join(' '));

      if (text.includes(owner)) return true;
      if (parts.length > 1 && parts.every((part) => text.includes(part))) return true;
      if (parts.length === 1 && text.includes(parts[0])) return true;
    }

    return false;
  }, ownerName).catch(() => false);
}

async function clearComposer(page, composer) {
  const isMac = os.platform() === 'darwin';
  await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await composer.evaluate((el) => {
    if ((el.innerText || el.textContent || '').trim()) {
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
    }
  }).catch(() => {});
}

async function readComposerText(composer) {
  return composer.evaluate((el) => (el.innerText || el.textContent || '').trim()).catch(() => '');
}

async function findSendButton(page, composer = null) {
  if (composer) {
    const scoped = await findSendButtonNearComposer(composer);
    if (scoped) return scoped;
  }

  const candidates = page.locator('.msg-form button:visible, [class*="msg-overlay"] button:visible, [role="dialog"] button:visible');
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const button = candidates.nth(i);
    const info = await button.evaluate((el) => ({
      text: (el.textContent || '').trim(),
      ariaLabel: el.getAttribute('aria-label') || '',
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
    })).catch(() => null);
    if (!info || info.disabled) continue;
    if (/^send\b/i.test(info.ariaLabel) || /^send$/i.test(info.text)) return button;
  }
  return null;
}

async function findSendButtonNearComposer(composer) {
  const rootHandle = await composer.evaluateHandle((el) => {
    let best = el.closest('form') || el.parentElement;
    let node = el;

    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      const className = typeof node.className === 'string' ? node.className : '';
      const role = node.getAttribute?.('role') || '';
      if (role === 'dialog' || /msg-overlay|conversation|msg-form|compose/i.test(className)) {
        best = node;
      }
    }

    return best || el;
  }).catch(() => null);

  const root = rootHandle?.asElement();
  if (!root) {
    await rootHandle?.dispose?.().catch(() => {});
    return null;
  }

  const buttons = await root.$$('button').catch(() => []);
  for (const button of buttons) {
    const info = await button.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').trim(),
        ariaLabel: el.getAttribute('aria-label') || '',
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        visible: rect.width > 0 && rect.height > 0,
      };
    }).catch(() => null);

    if (!info || info.disabled || !info.visible) continue;
    if (/^send\b/i.test(info.ariaLabel) || /^send$/i.test(info.text)) {
      await rootHandle.dispose().catch(() => {});
      return button;
    }
  }

  await rootHandle.dispose().catch(() => {});
  return null;
}

async function waitForSendButton(page, composer, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const button = await findSendButton(page, composer);
    if (button) return button;
    await page.waitForTimeout(250);
  }
  return null;
}

async function waitForSendConfirmation(composer, expectedHead, timeoutMs) {
  const started = Date.now();
  let lastText = '';

  while (Date.now() - started < timeoutMs) {
    const stillVisible = await composer.isVisible().catch(() => false);
    const text = stillVisible ? await readComposerText(composer) : '';
    lastText = text;

    if (!stillVisible) return { ok: true, reason: 'Composer closed after Send.' };
    if (!text.includes(expectedHead)) return { ok: true, reason: 'Composer text cleared after Send.' };

    await composer.page().waitForTimeout(300);
  }

  return {
    ok: false,
    reason: `Send was clicked, but the draft still appears in the composer: "${lastText.slice(0, 60)}"`,
  };
}

async function logMessageButtonDiagnostics(page) {
  const buttons = await page.locator('button:visible').evaluateAll((els) => els
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        ariaLabel: (el.getAttribute('aria-label') || '').trim(),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    })
    .filter((b) => /message|inmail|connect|premium/i.test(`${b.text} ${b.ariaLabel}`))
    .slice(0, 20));
  console.log('[playwright-draft] button diagnostics:', JSON.stringify(buttons, null, 2));
}

async function logComposerDiagnostics(page) {
  const diagnostics = await page.evaluate(() => {
    const editables = Array.from(document.querySelectorAll('div[contenteditable="true"], [role="textbox"]'));
    return {
      url: location.href,
      contenteditableCount: editables.length,
      msgElementCount: document.querySelectorAll('[class*="msg-"]').length,
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
      editables: editables.slice(0, 10).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      }),
    };
  }).catch((err) => ({ error: err.message }));
  console.log('[playwright-draft] composer diagnostics:', JSON.stringify(diagnostics, null, 2));
}

function humanPause(min, max) {
  return new Promise((resolve) => setTimeout(resolve, randomInt(min, max)));
}

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}
