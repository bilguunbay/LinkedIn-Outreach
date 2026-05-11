// Background service worker — runs the LinkedIn send flow so it survives
// the popup closing. Popup talks to us via chrome.runtime.sendMessage and
// can listen for progress updates. We also persist the final result and
// fire a notification so the user gets feedback even with the popup gone.

const LAST_SEND_KEY            = 'last_send_result';
const CONSECUTIVE_FAILURES_KEY = 'consecutive_failures';
const HALTED_KEY               = 'halted';
const SEND_LOCK_KEY            = 'send_in_progress';

const MAX_CONSECUTIVE_FAILURES = 3;
const SEND_HARD_TIMEOUT_MS     = 30_000;

// ────────────────────────────────────────────────────────────
// Message dispatch
// ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'send_to_contact') {
    handleSend(msg)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[background] handleSend threw:', err);
        sendResponse({ ok: false, reason: 'Background error: ' + (err?.message || String(err)) });
      });
    return true; // keep channel open for async sendResponse
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
    try { chrome.runtime.sendMessage({ type: 'send_progress', text, kind }); } catch (_) {}
  };

  // ── Pre-checks: halt + concurrency lock ───────────────────
  const state = await chrome.storage.local.get([HALTED_KEY, SEND_LOCK_KEY, CONSECUTIVE_FAILURES_KEY]);

  if (state[HALTED_KEY]) {
    return {
      ok: false,
      reason: `Halted: ${state[HALTED_KEY].reason}. Click Reset in the popup to clear and continue.`,
      halted: true,
    };
  }

  if (state[SEND_LOCK_KEY]) {
    return {
      ok: false,
      reason: 'Another send is already in progress. Wait for it to finish.',
    };
  }

  // Acquire lock
  await chrome.storage.local.set({ [SEND_LOCK_KEY]: true });

  console.log('[background] send start', { url, contactName, messageLen: message.length });
  let tabId = null;
  let final;

  // ── The actual send, wrapped in a hard 30s timeout ────────
  try {
    final = await Promise.race([
      doSend(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${SEND_HARD_TIMEOUT_MS / 1000}s`)), SEND_HARD_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.error('[background] send failed:', err);
    final = { ok: false, reason: err?.message || String(err) };
  }

  async function doSend() {
    progress('Opening LinkedIn tab…');
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id;

    progress('Waiting for LinkedIn to load…');
    await waitForTabComplete(tabId);
    await sleep(2000); // let lazy-loaded UI settle (longer now that tab is active)

    progress('Sending message…');

    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: sendOnLinkedIn,
      args: [message],
    });

    return result || { ok: false, reason: 'No result returned from injected script (page may have crashed)' };
  }

  // ── Update consecutive-failure counter ────────────────────
  let halt = null;
  let newFailureCount = state[CONSECUTIVE_FAILURES_KEY] || 0;

  if (final.ok) {
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

  // ── Persist everything atomically ─────────────────────────
  await chrome.storage.local.set({
    [LAST_SEND_KEY]: { ...final, contactName, url, when: new Date().toISOString() },
    [CONSECUTIVE_FAILURES_KEY]: newFailureCount,
    [HALTED_KEY]: halt,
    [SEND_LOCK_KEY]: false,
  });

  // ── Fire OS notification ──────────────────────────────────
  try {
    let title = final.ok ? 'LinkedIn message sent' : 'LinkedIn send failed';
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

  // ── Best-effort live progress to popup if still open ──────
  if (halt) {
    progress('⛔ Halted — ' + halt.reason + '. Reset in popup to continue.', 'err');
  } else {
    progress(
      (final.ok ? '✓ ' : '✗ ') + (final.reason || 'Done') +
        (newFailureCount > 0 && !final.ok ? ` (${newFailureCount}/${MAX_CONSECUTIVE_FAILURES} failures)` : ''),
      final.ok ? 'ok' : 'err'
    );
  }

  console.log('[background] send done:', { final, newFailureCount, halt });
  return { ...final, halted: !!halt };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    setTimeout(finish, 20000); // hard cap
  });
}

// ────────────────────────────────────────────────────────────
// Function injected into the LinkedIn tab.
// Self-contained — no closures, no outer-scope references.
// Logs to console for debugging.
// ────────────────────────────────────────────────────────────

async function sendOnLinkedIn(messageText) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand  = (min, max) => sleep(min + Math.random() * (max - min));
  const log = (...args) => console.log('[outreach-cs]', ...args);

  // LinkedIn is React-based. To trigger its handlers reliably we need to
  // dispatch the full pointer+mouse event chain a real cursor would produce.
  // `isTrusted` will still be false (no way around that without chrome.debugger),
  // but with the full chain most modern React handlers respond correctly.
  const realClick = (el) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top  + rect.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1,
    };

    // PointerEvent chain (modern React listens here)
    try {
      el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerenter', { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true, bubbles: false }));
      el.dispatchEvent(new PointerEvent('pointermove',  { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerdown',  { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
    } catch (_) {}

    // MouseEvent chain (older listeners)
    el.dispatchEvent(new MouseEvent('mouseover',  base));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove',  base));
    el.dispatchEvent(new MouseEvent('mousedown',  base));

    // Focus the button
    try { el.focus(); } catch (_) {}

    // Up
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true, buttons: 0 })); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));

    // The click
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));

    // And a native .click() as belt-and-suspenders
    try { el.click(); } catch (_) {}
  };

  log('content script start', { url: location.href, len: messageText?.length });

  // Allow LinkedIn's heavy lazy-loaded UI to render
  await sleep(1500);

  const url = location.href;

  if (/\/(login|checkpoint|authwall|uas\/login)/.test(url)) {
    return { ok: false, reason: 'Not signed in to LinkedIn — please sign in and try again.' };
  }
  if (/\/search\//.test(url)) {
    return {
      ok: false,
      reason: 'This is a LinkedIn search page, not a profile. Use a direct URL like https://www.linkedin.com/in/<handle>/',
    };
  }

  // ── Identify the profile owner so we click the RIGHT Message button ──
  // LinkedIn profile pages show Message buttons in many places — the top
  // card (right one), "People also viewed" sidebar (wrong), the messaging
  // panel toggle at the bottom (totally wrong), even your own profile pic
  // dropdown in the global nav. Without the right person to compare against,
  // we'll click the wrong button. Detect them from 3 sources, in order:
  //   1. The profile <h1> (highest signal, but sometimes not rendered yet)
  //   2. <title> tag (always present, format: "Name | LinkedIn")
  //   3. URL slug parsing (last resort: /in/alison-nguyen-XXXXX/)
  const detectProfileOwner = async () => {
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
    // Retry over ~3 seconds — H1 may render lazily
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const sel of h1Selectors) {
        try {
          const el = document.querySelector(sel);
          const txt = el?.textContent?.trim();
          if (txt && txt.length < 100) return { name: txt, source: 'h1' };
        } catch (_) {}
      }
      if (attempt < 5) await sleep(500);
    }

    // Fallback 1: document.title — "Alison Nguyen | LinkedIn" or "Alison Nguyen - Founder | LinkedIn"
    if (document.title && document.title.includes('|')) {
      const namepart = document.title.split('|')[0].trim();
      const cleaned = namepart.replace(/\s*-.*$/, '').trim();
      if (cleaned && cleaned !== 'LinkedIn' && cleaned.length < 100) {
        return { name: cleaned, source: 'title' };
      }
    }

    // Fallback 2: URL slug. /in/alison-nguyen-549772295/ → "Alison Nguyen"
    const m = location.pathname.match(/\/in\/([^/?#]+)/);
    if (m) {
      const parts = m[1].split('-').filter((p) => !/^\d+$/.test(p) && p);
      if (parts.length >= 2) {
        const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
        return { name, source: 'url-slug' };
      }
    }

    return null;
  };

  const owner = await detectProfileOwner();
  log('profile owner detected:', owner);
  const profileOwner = owner?.name || null;

  // ── Find Message button (POSITION-based, since LinkedIn keeps changing classes) ──
  const isInsideFixedOrSticky = (el) => {
    let n = el.parentElement;
    while (n) {
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed' || cs.position === 'sticky') return true;
      n = n.parentElement;
    }
    return false;
  };

  const findMessageButton = () => {
    const visible = Array.from(document.querySelectorAll('button:not([disabled])'))
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

    // Build annotated candidate list with hard filters applied up front
    const all = [];
    for (const btn of visible) {
      const label = (btn.getAttribute('aria-label') || '').trim();
      const text  = (btn.textContent || '').trim();
      const lLow  = label.toLowerCase();

      // Hard exclusions on label content
      if (lLow.includes('inmail') || lLow.includes('in-mail')) continue;
      if (lLow.includes('premium')) continue;       // Premium upsell promos
      if (!/^Message\b/i.test(label) && !/^Message$/i.test(text)) continue;

      const rect = btn.getBoundingClientRect();

      // Position-based exclusions — these are robust to LinkedIn class changes
      if (rect.y < 60) continue;                    // global nav strip at top
      if (isInsideFixedOrSticky(btn)) continue;     // overlays / toggles / sticky bars

      all.push({
        btn, label, text,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        inTopCard:    !!btn.closest('.pv-top-card, .pv-top-card-v2-ctas, .pvs-profile-actions, .pv-text-details__left-panel, [class*="profile-actions"], [class*="top-card"]'),
        inMsgOverlay: !!btn.closest('[class*="msg-overlay"]'),
        inGlobalNav:  !!btn.closest('.global-nav, #global-nav, [class*="global-nav"]'),
        inAside:      !!btn.closest('aside'),
      });
    }

    // Verbose, expand-free logging so each candidate is visible in the console
    log('Message button candidates count:', all.length);
    all.forEach((c, i) => {
      log(
        `  cand[${i}]: ` + JSON.stringify({
          label: c.label,
          text: c.text.slice(0, 40),
          pos: `(${c.x},${c.y})`,
          inTopCard: c.inTopCard,
          inMsgOverlay: c.inMsgOverlay,
          inAside: c.inAside,
          inGlobalNav: c.inGlobalNav,
        })
      );
    });

    // Diagnostic: what's actually in the profile's top-card action area?
    const topCardEl = document.querySelector('.pv-top-card, .pv-top-card-v2-ctas, .pvs-profile-actions, .pv-text-details__left-panel');
    if (topCardEl) {
      const topButtons = Array.from(topCardEl.querySelectorAll('button:not([disabled])'))
        .map((b) => JSON.stringify({
          aria: b.getAttribute('aria-label'),
          text: b.textContent?.trim().slice(0, 40),
        }));
      log('Top-card buttons (all of them):', topButtons.length);
      topButtons.forEach((s, i) => log(`  topbtn[${i}]: ` + s));
    } else {
      log('NO top-card element found — page selectors may be stale');
    }

    if (!all.length) return null;

    // Hard exclude: messaging overlay toggle (NOT what we want) and global-nav widgets
    let candidates = all.filter((c) => !c.inMsgOverlay && !c.inGlobalNav);
    if (!candidates.length) {
      log('all candidates were excluded as msg-overlay or global-nav');
      return null;
    }

    // 1. Match by profile owner name (full match, then first name)
    if (profileOwner) {
      const fullLow  = profileOwner.toLowerCase();
      const firstLow = profileOwner.split(/\s+/)[0]?.toLowerCase() || '';

      const exact = candidates.find(({ label }) =>
        label.toLowerCase() === `message ${fullLow}` ||
        label.toLowerCase() === `message ${firstLow}`
      );
      if (exact) { log('matched profile owner exactly:', exact.label); return exact.btn; }

      const containsFull = candidates.find(({ label }) => label.toLowerCase().includes(fullLow));
      if (containsFull) { log('matched profile owner (contains full):', containsFull.label); return containsFull.btn; }
    }

    // 2. Prefer button inside the top-card / profile-actions area
    const inTopCard = candidates.find((c) => c.inTopCard);
    if (inTopCard) { log('matched by top-card location:', inTopCard.label); return inTopCard.btn; }

    // 3. Prefer button NOT in an aside / sidebar widget
    const notInAside = candidates.find((c) => !c.inAside);
    if (notInAside) { log('matched (not in aside):', notInAside.label); return notInAside.btn; }

    // 4. Last resort: shortest label (more generic = less likely to be a sidebar widget naming someone else)
    log('falling back to shortest-label heuristic — no owner match, no top-card hit');
    candidates.sort((a, b) => a.label.length - b.label.length);
    return candidates[0].btn;
  };

  const findInMailButton = () => {
    const all = document.querySelectorAll('button:not([disabled])');
    for (const b of all) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      if (l.includes('inmail')) return b;
    }
    return null;
  };

  const findConnectButton = () => {
    const all = document.querySelectorAll('button:not([disabled])');
    for (const b of all) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').toLowerCase().trim();
      if (l.startsWith('invite ') || l.includes('to connect') || t === 'connect') return b;
    }
    return null;
  };

  const messageBtn = findMessageButton();
  log('chose messageBtn:', messageBtn?.getAttribute('aria-label') || messageBtn?.textContent?.trim());

  // Safety guard: if we accidentally selected a button for the logged-in user
  // (which appears in places like "Recently messaged"), bail out instead of
  // clicking it. We detect "you" by reading the nav profile alt text.
  const meAlt = (document.querySelector('.global-nav__me-photo, .global-nav img[alt]')?.getAttribute('alt') || '').trim().toLowerCase();
  const chosenLabelLow = (messageBtn?.getAttribute('aria-label') || '').toLowerCase();
  if (meAlt && chosenLabelLow && chosenLabelLow.includes(meAlt)) {
    log('REFUSING to click: the chosen button is addressed to the logged-in user', { meAlt, chosenLabelLow });
    return {
      ok: false,
      reason: `Could not locate a Message button for "${profileOwner || 'the profile owner'}". The only candidates on the page were addressed to you (the logged-in user). LinkedIn may have changed the profile page layout, or this contact does not have a Message button visible.`,
    };
  }

  if (!messageBtn) {
    if (findInMailButton()) {
      return { ok: false, reason: 'Profile only allows InMail (paid) — skipping for safety.' };
    }
    if (findConnectButton()) {
      return { ok: false, reason: 'Not yet a 1st-degree connection. Send a connect request first, then message.' };
    }
    return {
      ok: false,
      reason: 'No Message button found on this profile. The profile may be private, the contact may have messaging disabled, or LinkedIn changed their UI.',
    };
  }

  // ── Click Message → wait for the dialog ──────────────────
  messageBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
  await rand(300, 600);

  // Snapshot state before click so we can diff afterward
  const urlBefore = location.href;
  const editableCountBefore = document.querySelectorAll('div[contenteditable="true"]').length;

  // Watch for any new nodes added to the DOM after the click. This will
  // catch the message overlay being injected even if we miss it with selectors.
  const newClassesObserved = new Set();
  const newNodesObserved   = [];
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const cls = (n.className && typeof n.className === 'string') ? n.className : '';
        if (cls) newClassesObserved.add(cls);
        if (newNodesObserved.length < 10) newNodesObserved.push({ tag: n.tagName, cls: cls.slice(0, 100) });
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  log('clicking Message button…');
  realClick(messageBtn);

  log('clicked, waiting for dialog…');
  await rand(900, 1500);

  const findInput = () => {
    const cands = [
      // Inline message overlay (bottom-right floating dialog)
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-form__msg-content-container div[contenteditable="true"]',
      '.msg-form div[contenteditable="true"]',
      // Full /messaging/thread page
      '.msg-overlay-conversation-bubble div[contenteditable="true"]',
      '.msg-overlay-base-conversation-bubble div[contenteditable="true"]',
      // Semantic
      'div[role="textbox"][aria-label*="message" i]',
      'div[contenteditable="true"][aria-label*="message" i]',
      // Last resort: any contenteditable inside any msg- element
      '[class*="msg-"] div[contenteditable="true"]',
    ];
    for (const s of cands) {
      try { const el = document.querySelector(s); if (el && el.offsetParent !== null) return el; } catch (_) {}
    }
    return null;
  };

  // Wait up to ~12 seconds for the dialog
  let input = null;
  for (let i = 0; i < 30 && !input; i++) {
    input = findInput();
    if (!input) await sleep(400);
  }

  observer.disconnect();

  if (!input) {
    // Comprehensive diagnostic: tell us what happened after the click.
    const urlAfter = location.href;
    const allEditable = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
    const msgEls      = document.querySelectorAll('[class*="msg-"]');

    log('====== DIAGNOSTIC: input not found ======');
    log('URL before click:', urlBefore);
    log('URL after click: ', urlAfter);
    log('URL changed?    :', urlBefore !== urlAfter);
    log('contenteditable count BEFORE click:', editableCountBefore);
    log('contenteditable count AFTER click :', allEditable.length);
    log('msg-* element count               :', msgEls.length);
    log('DOM nodes added after click       :', newNodesObserved.length);
    newNodesObserved.forEach((n, i) => log(`  added node [${i}]`, n));
    log('unique classes on added nodes     :', Array.from(newClassesObserved).slice(0, 20));

    // Build a useful one-line reason
    let reason;
    if (urlBefore !== urlAfter) {
      reason = `Click navigated to a new URL (${urlAfter.replace(/^https?:\/\/[^/]+/, '')}). LinkedIn opened messaging on a different page — our injected script doesn't follow navigations. We'll need to handle this differently.`;
    } else if (newNodesObserved.length === 0) {
      reason = `Click did not trigger any DOM change. LinkedIn's React handler likely ignored the synthetic click (isTrusted: false). Real-cursor clicks via chrome.debugger are the next step.`;
    } else {
      reason = `Click triggered DOM changes but no message dialog appeared. ${newNodesObserved.length} new nodes were added but none matched expected dialog selectors. Check the LinkedIn tab DevTools console for the DIAGNOSTIC dump.`;
    }

    return { ok: false, reason };
  }

  log('found input:', input.className);

  // ── Type the message ──────────────────────────────────────
  // Focus + place caret at end of any existing content so we don't overwrite.
  input.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_) {}
  await sleep(250);

  for (const ch of messageText) {
    document.execCommand('insertText', false, ch);
    // After each character, fire an input event so React's onChange picks it up.
    // (execCommand SHOULD fire one, but in some Chrome versions React misses it.)
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: ch, composed: true,
      }));
    } catch (_) {}
    if (/[.!?]/.test(ch) && Math.random() < 0.7) await rand(200, 600);
    else await rand(40, 130);
  }

  // Longer pause after typing so React state has time to settle before we
  // ask Send to consume it.
  await rand(900, 1400);

  // Final "the user is done typing" nudge.
  try {
    input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true }));
    input.dispatchEvent(new Event('change',     { bubbles: true }));
    input.dispatchEvent(new Event('blur',       { bubbles: true }));
    input.focus();
  } catch (_) {}

  // ── Verify text actually landed in the DOM ───────────────
  const entered = (input.innerText || input.textContent || '').trim();
  const head = messageText.trim().slice(0, 12);
  log('verify typed text:', { enteredHead: entered.slice(0, 30), expectedHead: head });
  if (!entered.includes(head)) {
    return { ok: false, reason: 'Typed text did not appear in the message field — aborting before send.' };
  }

  // ── Find + click Send ────────────────────────────────────
  await rand(500, 900);

  const findSendButton = () => {
    const cands = [
      '.msg-form__send-button',
      '.msg-form__right-actions button',
      'button.msg-form__send-btn',
      'button[type="submit"][class*="send" i]',
    ];
    for (const s of cands) {
      try { const el = document.querySelector(s); if (el && !el.disabled) return el; } catch (_) {}
    }
    // Fallback by aria-label / text inside the form
    const formButtons = document.querySelectorAll('.msg-form button:not([disabled])');
    for (const b of formButtons) {
      const lbl = (b.getAttribute('aria-label') || '').trim();
      const txt = (b.textContent || '').trim();
      if (/^Send\b/i.test(lbl) || /^Send$/i.test(txt)) return b;
    }
    // Last-ditch broader scan inside any msg- overlay
    const overlay = document.querySelector('[class*="msg-overlay"], [class*="msg-form"]');
    if (overlay) {
      const all = overlay.querySelectorAll('button:not([disabled])');
      for (const b of all) {
        const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
        const txt = (b.textContent || '').toLowerCase().trim();
        if (lbl === 'send' || txt === 'send') return b;
      }
    }
    return null;
  };

  let sendButton = findSendButton();
  log('sendButton initial:', sendButton, sendButton && { disabled: sendButton.disabled, aria: sendButton.getAttribute('aria-label') });

  // Send button is often disabled until React state catches up with our text.
  // Wait up to ~5s for it to become enabled.
  for (let i = 0; i < 12 && (!sendButton || sendButton.disabled); i++) {
    await sleep(400);
    sendButton = findSendButton();
  }

  if (!sendButton) {
    return { ok: false, reason: 'Send button not found. Message was typed but not sent.' };
  }
  if (sendButton.disabled) {
    return { ok: false, reason: 'Send button stayed disabled after typing — LinkedIn likely did not register the typed message in its React state. Send not attempted.' };
  }

  log('clicking Send…');
  realClick(sendButton);

  // ── Verify the send actually happened ────────────────────
  // LinkedIn clears the message input after a successful send. If our text
  // is still in the input 2s after clicking Send, the send didn't go through.
  await sleep(2000);
  const stillThere = (input.innerText || input.textContent || '').trim();
  const messageGone = !stillThere || !stillThere.includes(head);
  log('post-send input state:', { remainingHead: stillThere.slice(0, 30), messageGone });

  if (!messageGone) {
    return {
      ok: false,
      reason: 'Send was clicked but the message stayed in the input — LinkedIn did not actually send it. Likely a synthetic-click rejection (isTrusted) or a hidden validation block.',
    };
  }

  return { ok: true, reason: 'Message sent.' };
}
