// Background service worker — runs the LinkedIn send flow so it survives
// the popup closing. LinkedIn DOM inspection happens through injected scripts;
// real clicks and typing happen through chrome.debugger/CDP input commands.

const LAST_SEND_KEY            = 'last_send_result';
const CONSECUTIVE_FAILURES_KEY = 'consecutive_failures';
const HALTED_KEY               = 'halted';
const SEND_LOCK_KEY            = 'send_in_progress';

const MAX_CONSECUTIVE_FAILURES = 3;
const SEND_HARD_TIMEOUT_MS     = 120_000;
const SEND_TIMEOUT_PER_CHAR_MS = 180;
const DEBUGGER_PROTOCOL        = '1.3';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'send_to_contact') {
    handleSend(msg)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[background] handleSend threw:', err);
        sendResponse({ ok: false, reason: 'Background error: ' + (err?.message || String(err)) });
      });
    return true;
  }

  if (msg?.type === 'reset_halt') {
    chrome.storage.local.set({
      [HALTED_KEY]: null,
      [CONSECUTIVE_FAILURES_KEY]: 0,
      [SEND_LOCK_KEY]: false,
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function handleSend({ url, message, contactName }) {
  const progress = (text, kind = 'pending') => {
    try {
      const pending = chrome.runtime.sendMessage({ type: 'send_progress', text, kind });
      if (pending?.catch) pending.catch(() => {});
    } catch (_) {}
  };

  const state = await chrome.storage.local.get([HALTED_KEY, SEND_LOCK_KEY, CONSECUTIVE_FAILURES_KEY]);

  if (state[HALTED_KEY]) {
    return {
      ok: false,
      reason: `Halted: ${state[HALTED_KEY].reason}. Click Reset in the popup to clear and continue.`,
      halted: true,
    };
  }

  if (state[SEND_LOCK_KEY]) {
    return { ok: false, reason: 'Another send is already in progress. Wait for it to finish.' };
  }

  await chrome.storage.local.set({ [SEND_LOCK_KEY]: true });

  console.log('[background] send start', { url, contactName, messageLen: message.length });
  let final;
  const hardTimeoutMs = Math.max(SEND_HARD_TIMEOUT_MS, 30_000 + message.length * SEND_TIMEOUT_PER_CHAR_MS);

  try {
    final = await Promise.race([
      doSend({ url, message, progress }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${Math.round(hardTimeoutMs / 1000)}s`)), hardTimeoutMs)
      ),
    ]);
  } catch (err) {
    console.error('[background] send failed:', err);
    final = { ok: false, reason: err?.message || String(err) };
  }

  let halt = null;
  let newFailureCount = state[CONSECUTIVE_FAILURES_KEY] || 0;
  const isSkip = !!final.skip_reason;

  if (final.ok) {
    newFailureCount = 0;
  } else if (isSkip) {
    newFailureCount = 0;
  } else {
    newFailureCount += 1;
    if (newFailureCount >= MAX_CONSECUTIVE_FAILURES) {
      halt = {
        reason: `${MAX_CONSECUTIVE_FAILURES} sends failed in a row`,
        when: new Date().toISOString(),
      };
    }
  }

  await chrome.storage.local.set({
    [LAST_SEND_KEY]: { ...final, contactName, url, when: new Date().toISOString() },
    [CONSECUTIVE_FAILURES_KEY]: newFailureCount,
    [HALTED_KEY]: halt,
    [SEND_LOCK_KEY]: false,
  });

  try {
    let title = final.ok ? (final.drafted ? 'LinkedIn message drafted' : 'LinkedIn message sent') : (isSkip ? 'LinkedIn profile skipped' : 'LinkedIn send failed');
    let body  = `${contactName || 'Contact'}: ${final.reason || ''}`;
    if (halt) {
      title = 'LinkedIn Outreach halted';
      body  = `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Open the popup to reset.`;
    }
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: body.slice(0, 200),
    });
  } catch (e) {
    console.warn('[background] notifications.create failed:', e);
  }

  if (halt) {
    progress('Halted - ' + halt.reason + '. Reset in popup to continue.', 'err');
  } else {
    progress(
      (final.ok ? 'OK: ' : 'Failed: ') + (final.reason || 'Done') +
        (newFailureCount > 0 && !final.ok ? ` (${newFailureCount}/${MAX_CONSECUTIVE_FAILURES} failures)` : ''),
      final.ok ? 'ok' : 'err'
    );
  }

  console.log('[background] send done:', { final, newFailureCount, halt });
  return { ...final, halted: !!halt };
}

async function doSend({ url, message, progress }) {
  let tabId = null;
  let debuggerAttached = false;

  progress('Opening LinkedIn tab...');
  const tab = await chrome.tabs.create({ url, active: true });
  tabId = tab.id;
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}

  progress('Waiting for LinkedIn to load...');
  await waitForTabComplete(tabId);
  await sleep(2200);

  try {
    progress('Inspecting profile...');
    const profile = await runInjected(tabId, inspectLinkedInProfile);
    if (!profile?.ok) return normalizeInspectionFailure(profile);
    if (profile.state !== 'messageable') return normalizeInspectionFailure(profile);
    await tabLog(tabId, 'inspect result', {
      label: profile.messageButtonLabel,
      rect: roundedRect(profile.messageButtonRect),
    });

    progress('Open LinkedIn Message manually. Waiting for composer...');
    logDebugger('manual draft mode: waiting for composer', { tabId, timeoutMs: 60_000 });
    await tabLog(tabId, 'manual draft mode: waiting for composer');
    let input = await pollInjected(tabId, findMessageInput, 60_000, 500);
    if (!input?.ok) {
      const composerDiagnostics = await runInjected(tabId, inspectMessageDialogState, [profile.messageButtonRect]);
      logDebugger('manual composer not detected', composerDiagnostics);
      await tabLog(tabId, 'manual composer not detected', composerDiagnostics);
      return {
        ok: false,
        reason: 'No LinkedIn message composer detected after 60 seconds. Open the Message box manually in the LinkedIn tab, then try drafting again.',
      };
    }
    logDebugger('input found', input.inputRect);
    await tabLog(tabId, 'input found after manual composer open', roundedRect(input.inputRect));

    progress('Drafting message...');
    const directDraft = await runInjected(tabId, draftMessageIntoComposer, [message]);
    logDebugger('direct draft result', directDraft);
    await tabLog(tabId, 'direct draft result', directDraft);

    if (!directDraft?.ok) {
      await attachDebugger(tabId);
      debuggerAttached = true;
      logDebugger('attached', { tabId });
      try { await sendDebuggerCommand(tabId, 'Page.bringToFront'); } catch (_) {}
      await tabLog(tabId, 'debugger attached for typing');

      await tabLog(tabId, 'clicking message input via debugger', roundedRect(input.inputRect));
      await debuggerClick(tabId, input.inputRect, 'Message input');
      await sleep(250);
      await tabLog(tabId, 'typing via debugger fallback', { length: message.length });
      await debuggerType(tabId, message);
    }

    await sleep(700);
    const typed = await runInjected(tabId, readMessageInput);
    const expectedHead = message.trim().slice(0, 12);
    logDebugger('typing verified', { expectedHead, actualHead: typed?.text?.slice(0, 30) });
    await tabLog(tabId, 'typing verify', { expectedHead, actualHead: typed?.text?.slice(0, 30) });
    if (!typed?.text?.includes(expectedHead)) {
      return { ok: false, reason: 'Typed text did not appear in the message field - draft was not completed.' };
    }

    progress('Draft inserted. Review and send manually.', 'ok');
    await tabLog(tabId, 'draft inserted; send left manual');
    return { ok: true, drafted: true, reason: 'Message drafted in LinkedIn composer. Review and click Send manually.' };
  } finally {
    if (debuggerAttached) {
      try {
        await detachDebugger(tabId);
        logDebugger('detached', { tabId });
        await tabLog(tabId, 'debugger detached');
      } catch (err) {
        console.warn('[outreach-debugger] detach failed:', err);
      }
    }
  }
}

function normalizeInspectionFailure(result) {
  if (!result) return { ok: false, reason: 'No result returned from injected script.' };
  return {
    ok: false,
    reason: result.reason || 'LinkedIn profile is not messageable.',
    skip_reason: result.state,
  };
}

function classifyMessageDialogFailure(dialogState) {
  const text = safeJson(dialogState || {}).toLowerCase();
  if (text.includes('premium') || text.includes('inmail') || text.includes('with premium')) {
    return {
      state: 'inmail_required',
      reason: 'LinkedIn did not open a standard message composer and showed Premium/InMail messaging signals. Skipping this profile.',
    };
  }
  return {
    state: 'messaging_disabled',
    reason: 'Debugger activation reached the Message button, but LinkedIn did not open a message composer.',
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.status === 'complete') finish();
    });
    setTimeout(finish, 20000);
  });
}

async function runInjected(tabId, func, args = []) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result;
}

async function pollInjected(tabId, func, timeoutMs, intervalMs) {
  const start = Date.now();
  let lastResult = null;
  while (Date.now() - start < timeoutMs) {
    lastResult = await runInjected(tabId, func);
    if (lastResult?.ok) return lastResult;
    await sleep(intervalMs);
  }
  return lastResult || { ok: false };
}

function logDebugger(message, detail = {}) {
  console.log('[outreach-debugger]', message, safeJson(detail));
}

function roundedRect(rect) {
  if (!rect) return null;
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

async function tabLog(tabId, message, detail = {}) {
  try {
    await runInjected(tabId, (m, d) => console.log('[outreach-debugger]', m, d), [message, safeJson(detail)]);
  } catch (_) {}
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function uniqueMessageOptions(profile) {
  const options = [
    {
      label: profile.messageButtonLabel || '',
      text: '',
      rect: profile.messageButtonRect,
      source: 'chosen',
    },
    ...(profile.messageButtonOptions || []),
  ];
  const seen = new Set();
  const unique = [];

  for (const option of options) {
    const rect = option?.rect;
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue;
    const key = [
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(option);
  }

  return unique;
}

function attachDebugger(tabId) {
  const target = { tabId };
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_PROTOCOL, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(
          `Could not attach Chrome debugger: ${err.message}. Close DevTools or any other debugger attached to this tab, then try again.`
        ));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(tabId) {
  const target = { tabId };
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function sendDebuggerCommand(tabId, method, params = {}) {
  const target = { tabId };
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method} failed: ${err.message}`));
      else resolve(result);
    });
  });
}

async function debuggerClick(tabId, rect, label) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    throw new Error(`Cannot click ${label}: invalid element rectangle.`);
  }

  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  logDebugger(`click ${label}`, { x: Math.round(x), y: Math.round(y), rect });

  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    pointerType: 'mouse',
  });
  await sleep(randomInt(80, 180));
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'mouse',
  });
  await sleep(randomInt(70, 160));
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'mouse',
  });
}

async function focusElementAtRect(tabId, rect) {
  await runInjected(tabId, (targetRect) => {
    const x = targetRect.x + targetRect.width / 2;
    const y = targetRect.y + targetRect.height / 2;
    const el = document.elementFromPoint(x, y);
    if (el && typeof el.focus === 'function') el.focus();
  }, [rect]);
}

async function debuggerPressKey(tabId, key) {
  const keyMap = {
    Enter: { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, code: 'Enter', text: '\r' },
    Space: { windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, code: 'Space', text: ' ' },
  };
  const mapped = keyMap[key];
  if (!mapped) throw new Error(`Unsupported key: ${key}`);

  await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
    nativeVirtualKeyCode: mapped.nativeVirtualKeyCode,
  });
  await sleep(randomInt(50, 120));
  await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
    nativeVirtualKeyCode: mapped.nativeVirtualKeyCode,
  });
}

async function debuggerType(tabId, text) {
  for (const ch of text) {
    await sendDebuggerCommand(tabId, 'Input.insertText', { text: ch });
    if (/[.!?]/.test(ch) && Math.random() < 0.7) await sleep(randomInt(200, 600));
    else await sleep(randomInt(40, 130));
  }
}

function inspectLinkedInProfile() {
  const log = (...args) => console.log('[outreach-cs]', ...args);

  const visibleRect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      top: r.top,
      left: r.left,
      bottom: r.bottom,
      right: r.right,
    };
  };

  const scrollAndRect = (el) => {
    try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch (_) {}
    return visibleRect(el);
  };

  const url = location.href;
  log('content script inspect start', { url });

  if (/\/(login|checkpoint|authwall|uas\/login)/.test(url)) {
    return { ok: false, state: 'session_expired', reason: 'Not signed in to LinkedIn - please sign in and try again.' };
  }
  if (/\/search\//.test(url)) {
    return { ok: false, state: 'profile_unreachable', reason: 'This is a LinkedIn search page, not a profile.' };
  }

  const detectProfileOwner = () => {
    const h1Selectors = [
      'main h1.text-heading-xlarge',
      'main h1[class*="heading-xlarge"]',
      '.pv-top-card h1',
      '.ph5 h1',
      '.pv-text-details__left-panel h1',
      'main h1',
      'section h1',
      '[data-test-id*="profile-name"]',
    ];
    for (const sel of h1Selectors) {
      try {
        const txt = document.querySelector(sel)?.textContent?.trim();
        if (txt && txt.length < 100) return { name: txt, source: 'h1' };
      } catch (_) {}
    }
    if (document.title && document.title.includes('|')) {
      const cleaned = document.title.split('|')[0].trim().replace(/\s*-.*$/, '').trim();
      if (cleaned && cleaned !== 'LinkedIn' && cleaned.length < 100) return { name: cleaned, source: 'title' };
    }
    const m = location.pathname.match(/\/in\/([^/?#]+)/);
    if (m) {
      const parts = m[1].split('-').filter((p) => !/^\d+$/.test(p) && p);
      if (parts.length >= 2) {
        return { name: parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' '), source: 'url-slug' };
      }
    }
    return null;
  };

  const owner = detectProfileOwner();
  const profileOwner = owner?.name || null;
  const profileOwnerLow = (profileOwner || '').toLowerCase();
  const profileOwnerParts = profileOwnerLow.split(/\s+/).filter((p) => p.length > 1);
  log('profile owner detected:', owner);

  const isInsideFixedOrSticky = (el) => {
    let n = el.parentElement;
    while (n) {
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed' || cs.position === 'sticky') return true;
      n = n.parentElement;
    }
    return false;
  };

  const buttons = Array.from(document.querySelectorAll('button:not([disabled])'))
    .filter((b) => visibleRect(b));

  const findInMailButton = () => buttons.find((b) => {
    const l = (b.getAttribute('aria-label') || '').toLowerCase();
    return l.includes('inmail') || l.includes('in-mail');
  });

  const findPremiumMessageButton = () => buttons.find((b) => {
    const l = (b.getAttribute('aria-label') || '').toLowerCase();
    const t = (b.textContent || '').toLowerCase().trim();
    return (l.includes('message') || t === 'message' || t === 'say hello') && l.includes('premium');
  });

  const findConnectButton = () => buttons.find((b) => {
    const l = (b.getAttribute('aria-label') || '').toLowerCase();
    const t = (b.textContent || '').toLowerCase().trim();
    return l.startsWith('invite ') || l.includes('to connect') || t === 'connect';
  });

  const candidates = [];
  for (const btn of buttons) {
    const label = (btn.getAttribute('aria-label') || '').trim();
    const text = (btn.textContent || '').trim();
    const labelLow = label.toLowerCase();

    if (labelLow.includes('inmail') || labelLow.includes('in-mail')) continue;
    if (labelLow.includes('premium')) continue;
    if (!/^Message\b/i.test(label) && !/^Message$/i.test(text)) continue;
    if (profileOwnerLow && /^message\s+\S+/i.test(label)) {
      const target = label.replace(/^message\s+/i, '').trim().toLowerCase();
      const targetLooksLikeOwner =
        target.includes(profileOwnerLow) ||
        profileOwnerLow.includes(target) ||
        (profileOwnerParts.length > 0 && profileOwnerParts.every((part) => target.includes(part)));
      if (!targetLooksLikeOwner) continue;
    }

    const rect = visibleRect(btn);
    if (!rect || rect.y < 60) continue;
    if (isInsideFixedOrSticky(btn)) continue;

    candidates.push({
      btn,
      label,
      text,
      rect,
      inTopCard: !!btn.closest('.pv-top-card, .pv-top-card-v2-ctas, .pvs-profile-actions, .pv-text-details__left-panel, [class*="profile-actions"], [class*="top-card"]'),
      inMsgOverlay: !!btn.closest('[class*="msg-overlay"]'),
      inGlobalNav: !!btn.closest('.global-nav, #global-nav, [class*="global-nav"]'),
      inAside: !!btn.closest('aside'),
    });
  }

  log('Message button candidates:', candidates.map((c) => ({
    label: c.label,
    text: c.text.slice(0, 40),
    rect: { x: Math.round(c.rect.x), y: Math.round(c.rect.y), width: Math.round(c.rect.width), height: Math.round(c.rect.height) },
    inTopCard: c.inTopCard,
    inMsgOverlay: c.inMsgOverlay,
    inAside: c.inAside,
    inGlobalNav: c.inGlobalNav,
  })));

  let filtered = candidates.filter((c) => !c.inMsgOverlay && !c.inGlobalNav);

  const meAltRaw = (document.querySelector('.global-nav__me-photo, .global-nav img[alt]')?.getAttribute('alt') || '').trim();
  const meAlt = meAltRaw.toLowerCase();
  const meName = meAlt
    .replace(/\bview\s+profile\b/g, '')
    .replace(/\bopen\s+profile\b/g, '')
    .replace(/\byou\b/g, '')
    .trim();
  const ownNameParts = meName.split(/\s+/).filter((p) => p.length > 1);

  filtered = filtered.filter((c) => {
    const labelLow = (c.label || '').toLowerCase();
    if (!labelLow) return true;
    if (meName && labelLow.includes(meName)) return false;
    if (ownNameParts.length >= 2 && ownNameParts.every((part) => labelLow.includes(part))) return false;
    return true;
  });

  if (profileOwner && filtered.length) {
    const fullLow = profileOwner.toLowerCase();
    const firstLow = profileOwner.split(/\s+/)[0]?.toLowerCase() || '';
    const exact = filtered.find(({ label }) =>
      label.toLowerCase() === `message ${fullLow}` ||
      label.toLowerCase() === `message ${firstLow}`
    );
    if (exact) filtered = [exact];
    else {
      const containsFull = filtered.find(({ label }) => label.toLowerCase().includes(fullLow));
      if (containsFull) filtered = [containsFull];
    }
  }

  const chosen =
    filtered.find((c) => c.inTopCard) ||
    filtered.find((c) => !c.inAside) ||
    [...filtered].sort((a, b) => a.label.length - b.label.length)[0];

  if (!chosen) {
    if (findInMailButton()) return { ok: false, state: 'inmail_required', reason: 'Profile only allows InMail (paid) - skipping for safety.' };
    if (findPremiumMessageButton()) return { ok: false, state: 'inmail_required', reason: 'Profile appears to require LinkedIn Premium/InMail messaging - skipping for safety.' };
    if (findConnectButton()) return { ok: false, state: 'not_a_connection', reason: 'Not yet a 1st-degree connection. Send a connect request first, then message.' };
    return { ok: false, state: 'messaging_disabled', reason: 'No Message button found on this profile.' };
  }

  const chosenLabelLow = (chosen.label || '').toLowerCase();
  if (
    chosenLabelLow &&
    (
      (meName && chosenLabelLow.includes(meName)) ||
      (ownNameParts.length >= 2 && ownNameParts.every((part) => chosenLabelLow.includes(part)))
    )
  ) {
    return { ok: false, state: 'messaging_disabled', reason: 'Refusing to click a Message button addressed to the logged-in user.' };
  }

  const rect = scrollAndRect(chosen.btn);
  if (!rect) return { ok: false, state: 'messaging_disabled', reason: 'Message button was found but is not visible.' };
  const messageButtonOptions = filtered
    .map((c, index) => ({
      label: c.label || '',
      text: c.text || '',
      rect: visibleRect(c.btn),
      source: c === chosen ? 'chosen' : `candidate-${index}`,
      inTopCard: c.inTopCard,
      inAside: c.inAside,
    }))
    .filter((c) => c.rect);

  log('chose messageBtn:', chosen.label || chosen.text);
  return {
    ok: true,
    state: 'messageable',
    profileOwner,
    messageButtonLabel: chosen.label || chosen.text,
    messageButtonRect: rect,
    messageButtonOptions,
  };
}

function inspectClickTarget(rect) {
  const describe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const attr of Array.from(el.attributes || [])) {
      if (/^(aria-|data-|id$|class$|type$|role$)/i.test(attr.name)) {
        attrs[attr.name] = attr.value.slice(0, 180);
      }
    }
    const ancestry = [];
    let n = el;
    while (n && ancestry.length < 6) {
      ancestry.push({
        tag: n.tagName,
        id: n.id || '',
        className: typeof n.className === 'string' ? n.className.slice(0, 120) : '',
        ariaLabel: n.getAttribute?.('aria-label') || '',
        role: n.getAttribute?.('role') || '',
        text: (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
      });
      n = n.parentElement;
    }
    return {
      tag: el.tagName,
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
      ariaLabel: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      attrs,
      ancestry,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    };
  };

  if (!rect) return { ok: false, reason: 'No rect supplied.' };
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const el = document.elementFromPoint(x, y);
  const clickable = el?.closest?.('button, a, [role="button"]');

  return {
    ok: true,
    point: { x: Math.round(x), y: Math.round(y) },
    elementAtPoint: describe(el),
    clickableAtPoint: describe(clickable),
    activeElement: describe(document.activeElement),
  };
}

function installClickProbe(rect) {
  const describe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className.slice(0, 140) : '',
      ariaLabel: el.getAttribute?.('aria-label') || '',
      role: el.getAttribute?.('role') || '',
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  };
  const x = rect ? rect.x + rect.width / 2 : null;
  const y = rect ? rect.y + rect.height / 2 : null;
  const pointEl = rect ? document.elementFromPoint(x, y) : null;
  const clickable = pointEl?.closest?.('button, a, [role="button"]') || null;
  const state = {
    installedAt: new Date().toISOString(),
    point: rect ? { x: Math.round(x), y: Math.round(y) } : null,
    originalTarget: describe(clickable || pointEl),
    events: [],
  };
  const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown', 'keyup'];

  if (window.__outreachClickProbe?.cleanup) {
    try { window.__outreachClickProbe.cleanup(); } catch (_) {}
  }

  const listener = (event) => {
    const target = event.target;
    const nearest = target?.closest?.('button, a, [role="button"]') || target;
    state.events.push({
      type: event.type,
      isTrusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented,
      eventPhase: event.eventPhase,
      button: event.button,
      buttons: event.buttons,
      key: event.key,
      code: event.code,
      clientX: Number.isFinite(event.clientX) ? Math.round(event.clientX) : null,
      clientY: Number.isFinite(event.clientY) ? Math.round(event.clientY) : null,
      target: describe(target),
      nearestClickable: describe(nearest),
      activeElement: describe(document.activeElement),
    });
    if (state.events.length > 30) state.events.shift();
  };

  for (const type of eventTypes) document.addEventListener(type, listener, true);
  window.__outreachClickProbe = {
    state,
    cleanup() {
      for (const type of eventTypes) document.removeEventListener(type, listener, true);
    },
  };

  return { ok: true, installedAt: state.installedAt, originalTarget: state.originalTarget, point: state.point };
}

function readClickProbe() {
  const probe = window.__outreachClickProbe;
  if (!probe) return { ok: false, reason: 'Click probe was not installed.' };
  try { probe.cleanup(); } catch (_) {}
  const state = probe.state;
  window.__outreachClickProbe = null;
  return { ok: true, ...state };
}

function inspectMessageDialogState(rect) {
  const describe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
      ariaLabel: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    };
  };
  const x = rect ? rect.x + rect.width / 2 : 0;
  const y = rect ? rect.y + rect.height / 2 : 0;
  const pointEl = rect ? document.elementFromPoint(x, y) : null;
  const clickTarget = {
    ok: !!rect,
    point: rect ? { x: Math.round(x), y: Math.round(y) } : null,
    elementAtPoint: describe(pointEl),
    clickableAtPoint: describe(pointEl?.closest?.('button, a, [role="button"]')),
    activeElement: describe(document.activeElement),
  };
  const editableNodes = Array.from(document.querySelectorAll('div[contenteditable="true"], [role="textbox"]'));
  const dialogNodes = Array.from(document.querySelectorAll('[role="dialog"], [class*="msg-overlay"], [class*="msg-form"], [class*="msg-conversation"]'));
  const buttons = Array.from(document.querySelectorAll('button')).slice(0, 250);
  const messageLikeButtons = buttons
    .map((b) => ({
      ariaLabel: (b.getAttribute('aria-label') || '').trim(),
      text: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true',
      rect: (() => {
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })(),
    }))
    .filter((b) => /message|send/i.test(`${b.ariaLabel} ${b.text}`))
    .slice(0, 12);

  return {
    ok: true,
    url: location.href,
    clickTarget,
    activeTag: document.activeElement?.tagName || '',
    activeText: (document.activeElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    contenteditableCount: editableNodes.length,
    contenteditables: editableNodes.slice(0, 6).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        ariaLabel: el.getAttribute('aria-label') || '',
        role: el.getAttribute('role') || '',
        className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      };
    }),
    msgElementCount: document.querySelectorAll('[class*="msg-"]').length,
    dialogLikeCount: dialogNodes.length,
    dialogLikeSamples: dialogNodes.slice(0, 6).map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role') || '',
      className: typeof el.className === 'string' ? el.className.slice(0, 140) : '',
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    })),
    messageLikeButtons,
  };
}

function findMessageInput() {
  const log = (...args) => console.log('[outreach-cs]', ...args);
  const visibleRect = (el) => {
    const rect = el?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right,
    };
  };
  const describeInput = (el, selector) => {
    const rect = visibleRect(el);
    if (!el || !rect) return null;
    return {
      ok: true,
      selector,
      text: (el.innerText || el.textContent || '').trim(),
      inputRect: rect,
    };
  };
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
    try {
      const el = document.querySelector(selector);
      const found = describeInput(el, selector);
      if (found) {
        log('message input found:', selector);
        return found;
      }
    } catch (_) {}
  }

  const genericEditables = Array.from(document.querySelectorAll('div[contenteditable="true"], [role="textbox"]'))
    .map((el) => ({ el, rect: visibleRect(el) }))
    .filter(({ rect }) => rect && rect.y > 50);
  const likely = genericEditables.find(({ el }) =>
    !!el.closest('[role="dialog"], form, [class*="msg"], [class*="message"], [class*="compose"]')
  ) || (genericEditables.length === 1 ? genericEditables[0] : null);

  if (likely) {
    log('message input found by generic visible editable fallback');
    return describeInput(likely.el, 'generic visible editable fallback');
  }

  return {
    ok: false,
    reason: 'Message input not found.',
    diagnostics: {
      contenteditableCount: genericEditables.length,
      msgElementCount: document.querySelectorAll('[class*="msg-"]').length,
      editableSamples: genericEditables.slice(0, 8).map(({ el, rect }) => ({
        tag: el.tagName,
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      })),
    },
  };
}

function readMessageInput() {
  const visibleRect = (el) => {
    const rect = el?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  };
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
    const el = document.querySelector(selector);
    if (el && visibleRect(el)) return { ok: true, text: (el.innerText || el.textContent || '').trim(), selector };
  }
  const editables = Array.from(document.querySelectorAll('div[contenteditable="true"], [role="textbox"]'))
    .filter((el) => visibleRect(el));
  const el = editables.find((node) =>
    !!node.closest('[role="dialog"], form, [class*="msg"], [class*="message"], [class*="compose"]')
  ) || (editables.length === 1 ? editables[0] : null);
  if (!el) return { ok: false, reason: 'Message input not found.' };
  return { ok: true, text: (el.innerText || el.textContent || '').trim(), selector: 'generic visible editable fallback' };
}

function draftMessageIntoComposer(message) {
  const visibleRect = (el) => {
    const rect = el?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  };
  const findInput = () => {
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
      const el = document.querySelector(selector);
      if (el && visibleRect(el)) return { el, selector };
    }
    const editables = Array.from(document.querySelectorAll('div[contenteditable="true"], [role="textbox"]'))
      .filter((el) => visibleRect(el));
    const el = editables.find((node) =>
      !!node.closest('[role="dialog"], form, [class*="msg"], [class*="message"], [class*="compose"]')
    ) || (editables.length === 1 ? editables[0] : null);
    return el ? { el, selector: 'generic visible editable fallback' } : null;
  };

  const found = findInput();
  if (!found) return { ok: false, reason: 'Message composer input not found.' };

  const { el, selector } = found;
  const head = message.trim().slice(0, 12);
  try { el.focus(); } catch (_) {}

  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.deleteContents();
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch (_) {}

  let insertedWithCommand = false;
  try {
    insertedWithCommand = document.execCommand('insertText', false, message);
  } catch (_) {}

  let text = (el.innerText || el.textContent || '').trim();
  if (!text.includes(head)) {
    el.textContent = message;
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {}
  }

  try {
    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: 'insertText',
      data: message,
    }));
  } catch (_) {}
  try {
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: 'insertText',
      data: message,
    }));
  } catch (_) {
    try { el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch (__) {}
  }
  try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}

  text = (el.innerText || el.textContent || '').trim();
  return {
    ok: text.includes(head),
    selector,
    insertedWithCommand,
    actualHead: text.slice(0, 30),
    expectedHead: head,
    reason: text.includes(head) ? 'Draft inserted directly.' : 'Direct insertion did not update composer text.',
  };
}

function findSendButton() {
  const selectors = [
    '.msg-form__send-button',
    '.msg-form__right-actions button',
    'button.msg-form__send-btn',
    'button[type="submit"][class*="send" i]',
  ];

  const rectFor = (el) => {
    const rect = el?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right,
    };
  };

  const consider = (el, selector) => {
    const rect = rectFor(el);
    if (!el || !rect) return null;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { ok: false, reason: 'Send button is still disabled.' };
    }
    return { ok: true, selector, sendButtonRect: rect };
  };

  for (const selector of selectors) {
    try {
      const result = consider(document.querySelector(selector), selector);
      if (result?.ok) return result;
    } catch (_) {}
  }

  const formButtons = document.querySelectorAll('.msg-form button');
  for (const b of formButtons) {
    const lbl = (b.getAttribute('aria-label') || '').trim();
    const txt = (b.textContent || '').trim();
    if (/^Send\b/i.test(lbl) || /^Send$/i.test(txt)) {
      const result = consider(b, 'form button label');
      if (result?.ok) return result;
      return result;
    }
  }

  const overlay = document.querySelector('[class*="msg-overlay"], [class*="msg-form"]');
  if (overlay) {
    const all = overlay.querySelectorAll('button');
    for (const b of all) {
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      const txt = (b.textContent || '').toLowerCase().trim();
      if (lbl === 'send' || txt === 'send') {
        const result = consider(b, 'msg overlay send button');
        if (result?.ok) return result;
        return result;
      }
    }
  }

  return { ok: false, reason: 'Send button not found.' };
}
