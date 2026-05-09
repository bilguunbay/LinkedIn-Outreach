# Product Requirements Document: LinkedIn Outreach Personalizer

**Document Version:** 1.2
**Status:** Build-ready MVP
**Author:** Solo Developer (AI-assisted build)
**Last Updated:** May 2026

> **Major change from v1.1:** Architecture pivoted from Playwright + Native Messaging to a Chrome content script running in the user's actual logged-in LinkedIn session. Volume target reduced from 15–25/day to 5/day for 1st-degree connections only. Anti-detection scope narrowed accordingly — Playwright fingerprint controls (real-Chrome binary, headful, window randomization) are gone because they no longer apply when the script runs in the user's real Chrome.

---

## 1. Problem Statement

Manual LinkedIn outreach to people you already know — investors, advisors, past colleagues, candidates — is the highest-leverage form of outreach a solo operator can do. Reply rates are several times higher than cold outreach, and the social cost of a bad message is real: these are people in your network. But the per-message effort to do it well — open the profile, read recent activity, write something specific, paste, send — runs 3–7 minutes per contact. Across 5 contacts a day, that's 25–35 minutes of context-switching, most of it spent re-reading content you've already seen and writing variations of sentences you've written before.

The market has responded with two unsatisfying extremes:

- **Generic bulk-messaging tools** (Dux-Soup, Expandi, Linked Helper, etc.) that blast templated messages through cloud automation. They optimize for volume that personal outreach doesn't need, and their commercial-scale usage patterns are exactly what LinkedIn's bot detection is calibrated to catch. Accounts using them face restrictions, warnings, and bans.
- **Fully manual outreach**, which preserves account safety and personalization quality but doesn't scale beyond a handful of well-thought-out messages per day.

There is a missing middle for solo operators: a tool that **generates genuinely personalized messages** (using AI and the operator's own context), **respects account safety** (low daily volume, human-like timing, sends from the operator's real browser session), and **keeps the operator in the loop** with preview-and-approve gates. This PRD specifies that tool.

---

## 2. Goals & Success Metrics

### Primary Goal

Enable a single user to send **up to 5 personalized LinkedIn messages per day to 1st-degree connections**, cutting per-message authoring effort by ~80% versus fully manual workflows, with zero risk of account flags.

### Success Metrics

| Metric | Target | How Measured |
|---|---|---|
| Account flags / restrictions | **0** ever | Self-reported; absence of any LinkedIn warning emails or feature limits |
| Time to send 5 messages | ≤ **5 minutes** of active user time (vs ~25 min manual) | Self-reported timing |
| Setup-to-first-message | ≤ **5 minutes** for a new install | Tested on first-run flow |
| Reply rate vs cold templates | ≥ 2× baseline | Self-reported from inbox |

### Anti-Goals

- **Not** optimizing for volume. The tool will refuse to send more than 5 messages per day, period.
- **Not** a "set and forget" tool. Human review and click-to-send is a feature, not friction.
- **Not** for outreach to non-connections. The tool detects and skips them.

---

## 3. Target User

**Primary persona:** A solo operator doing personal outreach to people in their existing network.

- Solo founder messaging investors, advisors, design partners, or warm intros
- Sales professional following up with past contacts
- Recruiter checking in with previous candidates
- Anyone with 200–2,000 1st-degree LinkedIn connections and a recurring need to send 3–10 thoughtful messages a week

### Assumed Capabilities

- Comfortable installing a Chrome Extension from an unpacked folder (developer mode)
- Can produce or paste a CSV or PDF with contacts they want to reach
- Has an active LinkedIn account in good standing with regular human activity over recent months — not a brand-new or dormant account
- Has an Anthropic or OpenAI API key

### Explicitly NOT the target user

- Anyone wanting to send to non-connections
- Anyone wanting to send more than 5 messages per day
- Agencies running outreach across many client accounts
- Users uncomfortable installing an unpacked Chrome extension

---

## 4. Input Schema

The extension accepts a single CSV or PDF file per campaign. It tolerates header naming variations and normalizes everything to a canonical contact record.

### Canonical Record

```ts
type Contact = {
  company:      string;   // required
  name:         string;   // required (full name)
  role:         string;   // required (current role/title)
  linkedin_url: string;   // required (linkedin.com/in/... or linkedin.com/company/...)
  what_they_do?: string;  // optional context, used by AI personalization
  raised?:       string;  // optional context, used by AI personalization
  investors?:    string;  // optional context, used by AI personalization
};
```

### Header Aliases

Headers are normalized (lowercased, spaces → underscores, punctuation stripped) and mapped against an alias table:

| Canonical | Accepted source headers |
|---|---|
| `company` | `company`, `company_name`, `org`, `organization` |
| `name` | `name`, `founder_ceo`, `founder_ceo_name`, `founder`, `full_name`, `contact`, `person` |
| `role` | `role`, `title`, `position` |
| `linkedin_url` | `linkedin_url`, `linkedin`, `url`, `profile_url`, `profile` |
| `what_they_do` | `what_they_do`, `description`, `company_description`, `business` |
| `raised` | `raised`, `funding`, `amount_raised`, `funding_amount` |
| `investors` | `investors`, `investor`, `investor_s`, `backers` |

### Validation Rules

- Reject rows missing any required field (`company`, `name`, `role`, `linkedin_url`); surface them in a "Skipped" list with the reason
- Reject rows whose `name` is a placeholder ("Search on LinkedIn", "Find founder", etc.) — these are pre-research markers, not real contacts
- Strip parenthetical annotations from URLs (e.g., `(search to verify)`, `(find founder)`)
- Validate `linkedin_url` matches `linkedin.com/in/...` or `linkedin.com/company/...`
- Deduplicate by `linkedin_url`; keep first occurrence; warn about duplicates
- Hard cap: 200 rows per file (extras are skipped, not silently truncated)

### Sources

- **CSV** — parsed client-side, RFC-4180-ish (handles quoted fields, embedded commas, `""` escapes, CRLF)
- **PDF** — tabular PDFs (e.g., exported spreadsheets) are parsed using PDF.js with positioned text extraction, so column structure is recovered from the PDF's actual x-coordinates rather than guessing from text alone

---

## 5. Core Features (MVP)

### 5.1 File Upload & Parsing

- File-picker upload inside the extension popup
- Client-side parsing — file never leaves the machine
- Preview table showing canonical fields per row
- "Skipped" rows visible with the rejection reason
- User can clear the campaign and re-upload at any time

### 5.2 Message Template Editor

A textarea where the user writes a base message containing dynamic variables:

```
Hi {{name}},

Saw you're {{role}} at {{company}}. {{ai_personalization}}

Would love to compare notes — open to a 15-min call next week?

— Bilguun
```

Supported variables:

- `{{name}}` — first name extracted from `name`
- `{{full_name}}` — full value of `name`
- `{{company}}` — `company`
- `{{role}}` — `role`
- `{{ai_personalization}}` — AI-generated sentence using `what_they_do` + `raised` + `investors` + the user's personalization instructions

Templates are saved to `chrome.storage.local` and reusable across campaigns.

### 5.3 Personalization Instructions

A separate text area where the user describes how the AI should personalize. Examples:

- *"Mention their recent funding round if it's in the context. Keep it casual, one sentence, no flattery."*
- *"Reference a specific challenge their role likely faces. Don't use 'leverage' or 'synergies'."*

This guidance is sent to the AI alongside each row's data to produce the `{{ai_personalization}}` insert.

### 5.4 AI-Generated Preview Per Contact

Before any sending:

- The extension calls the AI API once per row, producing the final filled-in message
- Each preview is shown as a card: contact info, generated message, live character counter
- Four per-card actions: **Approve**, **Edit** (inline editor), **Regenerate** (re-runs AI for that one contact), **Skip**
- Bulk action: "Approve all remaining" (disabled if any preview exceeds the 1,900-character LinkedIn limit)
- Any over-limit message is flagged red and cannot be approved until edited or regenerated under the limit

### 5.5 Content-Script Sending

When the user clicks **Send** on an approved preview:

1. The extension opens (or reuses) a tab at the contact's LinkedIn profile in the user's existing Chrome session
2. A content script — declared with `host_permissions: ["https://*.linkedin.com/*"]` — runs in that tab
3. The content script:
   a. Inspects the page to determine messaging button state (see §5.6)
   b. If "Message" is available: clicks it, types the message with humanized per-keystroke delay, clicks Send
   c. Verifies the message appears in the conversation
   d. Checks for any LinkedIn warning patterns (see §6.10)
   e. Reports back to the popup — sent / skipped / failed / warning halt

Crucially, the content script runs in the **user's real Chrome session** with their real cookies, real User-Agent, real WebGL/Canvas signatures. There is no separate browser, no Playwright, no native host. Detection vectors that target Selenium/Playwright fingerprints (`navigator.webdriver`, missing modules, automation flags) do not apply — the only detection vector is behavioral, and behavioral signatures at 5/day to 1st-degree connections are indistinguishable from manual usage.

### 5.6 Message Button State Handling

LinkedIn profiles present different buttons depending on the operator's relationship to the contact. Each state has a dedicated handling path:

| Detected State | Meaning | Tool Behavior | Log |
|---|---|---|---|
| Standard **Message** button | 1st-degree connection | Proceed | `sent` (or `failed` if send errors) |
| **Send InMail** button (no plain Message) | Out of network | **Skip** | `inmail_required` |
| **Connect** button only | Not connected | **Skip** | `not_a_connection` |
| No messaging button | Profile owner disabled messaging | **Skip** | `messaging_disabled` |
| Profile fails to load | Stale URL or deleted account | **Skip** | `profile_unreachable` |

Skipped contacts (states 2–5) do not count against the daily cap and are clearly distinguished in the results CSV.

### 5.7 Send Queue UI

A live status panel in the extension showing every approved contact bucketed by state:

- **Pending** (queued)
- **Sending** (currently being processed)
- **Sent** (with timestamp)
- **Skipped** (with sub-reason)
- **Failed** (with error)

Daily counter is visible at all times: `Today: 3 / 5`.

User controls: **Pause**, **Resume**, **Stop**.

### 5.8 Result Logging & Export

On campaign end (or on demand), the extension exports a CSV with the original rows plus:

| Column | Description |
|---|---|
| `status` | `sent` / `failed` / `skipped` / `approved_not_sent` |
| `skip_reason` | If skipped, the specific reason |
| `sent_at` | ISO 8601 timestamp |
| `error` | Error message if failed |
| `final_message` | The exact text that was sent |

API keys are **never** included in any exported file or log.

---

## 6. Anti-Detection & Safety Requirements

> **At 5/day to 1st-degree connections, behavioral mimicry matters; environment fingerprinting does not.** The content script runs in the user's real Chrome — no Playwright fingerprint to mask. We drop §6.7–§6.10 from v1.1 (real-Chrome binary, headful, window randomization, channel: chrome) because they're irrelevant in this architecture. Behavioral controls remain.

### 6.1 Send Limits

| Limit | Default | Hard Maximum |
|---|---|---|
| Daily send cap | **5 messages** | **5 messages** |
| Weekly send cap | **25 messages** | **30 messages** |
| Send-free days per week | At least 1 (default Sunday) | — |

Counters persist across sessions and are visible at the top of the send queue at all times. The tool refuses to send when the daily cap is reached.

### 6.2 Account Warm-Up (optional)

For brand-new or 30+ days dormant accounts, the user can opt into a 2-week ramp:
- Week 1: 2/day
- Week 2: 5/day

For warm accounts (regular weekly activity), warm-up is off by default.

### 6.3 Time-of-Day Window

- Default: 8:00 AM – 6:00 PM in the user's local timezone
- Daily ±30-minute variance so sends never occur at perfectly identical times
- Outside the window: queue pauses gracefully

### 6.4 Message Character Limit

- Hard limit: 1,900 characters (LinkedIn's cap)
- Live counter on every preview card (yellow at 1,700+, red and approval-disabled at 1,900+)
- Over-limit messages can never enter the send queue

### 6.5 Randomized Delays Between Messages

- Default: uniform random **60–180 seconds** between sends
- Hard floor: 30 seconds
- At 5/day, no "long pause" cadence is needed — the entire queue is done in well under 15 minutes

### 6.6 Human-Like Typing

- `delay` parameter randomized **40–130ms per keystroke**
- Micro-pauses (200–600ms) at sentence boundaries
- Never paste; always type character by character
- Read back the message field's value after typing; abort send on mismatch

### 6.7 Real Chrome Session

The content script runs inside the user's existing logged-in LinkedIn tab in their normal Chrome window. There is no separate browser process and no Playwright. From LinkedIn's perspective, the actions are indistinguishable from the user's manual interaction.

### 6.8 Behavioral Realism

- Brief randomized scroll on the profile before opening the message dialog (simulates reading)
- Mouse movements (when needed for clicks) follow natural patterns, not instant teleports

### 6.9 Session Expiry Detection

Before each send, the content script verifies the LinkedIn nav is present (a reliable "logged in" signal) and that the page hasn't redirected to `/login` or `/checkpoint`. On detection:
1. Halt the queue immediately (the in-flight contact returns to Pending)
2. Surface a banner alert in the popup
3. Provide a **Re-authenticate** prompt — the user logs in manually in the same tab, then clicks Resume

Auto-resume is never attempted.

### 6.10 LinkedIn Warning Detection

After every navigation, the content script checks for:
- "You're approaching the weekly invitation limit"
- "We've restricted your account"
- CAPTCHA / phone verification screens
- "Unusual activity" prompts
- Message-rate-limit dialogs

On any detection: halt the queue immediately, surface a banner, require manual user confirmation before any further sends.

Consecutive-failure backoff: 3 consecutive failures stops the queue.

### 6.11 No Scraping

- The tool only navigates to URLs explicitly in the user's CSV/PDF
- Does not crawl search results, suggested connections, or any discovery surface
- Does not extract profile data beyond detecting the message-button state and verifying page load

---

## 7. User Flow

### Step 1: Install & first-run setup (one-time, ~5 minutes)

1. User loads the extension unpacked from `chrome://extensions`
2. Pinned extension icon visible in the toolbar
3. Extension popup shows the first-run checklist:
   - ⬜ Add AI API key
   - ⬜ Acknowledge ToS disclaimer
   - ⬜ Confirm warm-up setting (optional, default: off for warm accounts)
4. User adds their AI API key — stored in `chrome.storage.local` with a one-time security warning (§10)
5. User acknowledges the LinkedIn ToS disclaimer

### Step 2: Start a campaign

1. User opens the extension
2. Drops in a CSV or PDF file
3. Sees parsed preview table with row count and any validation warnings
4. Clicks **Continue**

### Step 3: Configure message

1. User writes or selects a saved template
2. User writes personalization instructions
3. Clicks **Generate previews**

### Step 4: Review & approve

1. AI generates personalized messages for all approved rows
2. User scrolls through preview cards: contact info + generated message + live character counter
3. For each: **Approve** / **Edit** / **Regenerate** / **Skip**
4. Bulk: **Approve all remaining**
5. Clicks **Start sending**

### Step 5: Send (active monitoring)

1. Popup shows the live send queue with daily counter `Today: 0 / 5`
2. For each approved contact:
   a. Extension opens (or activates) a LinkedIn profile tab in the user's Chrome
   b. Content script in that tab detects message button state and either sends or skips
   c. Reports back; popup updates queue UI
3. User can **Pause**, **Resume**, or **Stop** at any time
4. On warning: queue auto-halts with a banner
5. On session expiry: queue halts with a re-authenticate prompt
6. Outside active hours or daily limit reached: queue halts gracefully

### Step 6: Wrap up

1. Summary: X sent, Y skipped (with breakdown), Z failed
2. **Export results** → CSV downloads locally
3. User can start another campaign or close

---

## 8. Out of Scope (MVP)

- Sending connection requests
- Sending to non-connections (skipped, not sent)
- Scraping LinkedIn for contacts
- Multi-account support
- Scheduling / cron jobs
- CRM integrations
- Reply tracking / inbox monitoring
- A/B testing of message variants
- Team / sharing features
- Cloud sync
- Sending more than 5 messages/day

---

## 9. Functional Requirements

The product **must**:

1. Install as an unpacked Chrome Extension on Chromium-based browsers
2. Provide a popup UI for all configuration and orchestration
3. Use a content script with `host_permissions: ["https://*.linkedin.com/*"]` for LinkedIn DOM interaction
4. Accept CSV and PDF file uploads via file picker
5. Parse CSVs entirely client-side (RFC-4180-ish)
6. Parse PDFs entirely client-side using PDF.js with positioned text extraction
7. Validate every row per §4 and surface skipped rows with reasons
8. Deduplicate contacts by `linkedin_url` and warn about duplicates
9. Persist parsed contacts, settings, templates, counters, queue state in `chrome.storage.local`
10. Restore the active campaign on every popup open
11. Provide a message template editor supporting the variables in §5.2
12. Save and load reusable templates
13. Provide a personalization instructions text area
14. Make AI API calls (OpenAI or Anthropic) using a user-supplied API key stored locally
15. Generate one personalized preview per contact before any sending begins
16. Display a live character counter on every preview card
17. Prevent approval of any message exceeding 1,900 characters
18. Provide per-preview Approve / Edit / Regenerate / Skip
19. Allow bulk approval (disabled if any preview is over the limit)
20. On Send: open the contact's LinkedIn profile tab; inject (or message) the content script
21. Detect message button state and route correctly (Message → send; InMail → skip + log; Connect → skip + log; none → skip + log)
22. Type messages character-by-character with randomized 40–130ms per-keystroke delay
23. Insert micro-pauses (200–600ms) at sentence boundaries
24. Verify the message field after typing; abort on mismatch
25. Insert randomized 60–180s inter-message delay
26. Enforce daily cap of 5 with a persistent counter (chrome.alarms midnight reset)
27. Enforce active sending window (default 8 AM – 6 PM local)
28. Detect LinkedIn warning patterns and halt immediately on any detection
29. Detect session expiry and halt with re-authenticate prompt; never auto-resume
30. Halt after 3 consecutive failures
31. Display a live send queue with Pending / Sending / Sent / Skipped / Failed buckets
32. Display the daily counter prominently at all times
33. Allow Pause / Resume / Stop during an active campaign
34. Log every send attempt; never log API keys or auth tokens
35. Export a results CSV with status, skip_reason, sent_at, error, final_message
36. Refuse to scrape; navigate only to URLs explicitly in the user's CSV/PDF
37. Display a ToS disclaimer on first run with required acknowledgment
38. Display a one-time security warning when the user enters their API key
39. Persist user settings (delays, daily cap, active hours, off-day, API key, templates) across sessions

---

## 10. Non-Functional Requirements

### Performance

- Popup UI remains responsive during AI generation (async, non-blocking)
- AI preview generation parallelizes up to 5 concurrent requests; complete 5 previews in under 10 seconds
- File parsing handles a 200-row CSV in under 1 second; a typical tabular PDF in under 3 seconds
- Send queue UI updates within 500ms of a content-script event

### Reliability

- **Content script crash recovery:** If the content script throws, the extension catches the message-channel error within 5 seconds, marks the in-flight contact as `pending` (not failed), and prompts the user to retry
- **Network failure handling:** retry AI API calls up to 3 times with exponential backoff; do not retry LinkedIn sends (one attempt per contact, then fail)
- **Send queue state persists** to `chrome.storage.local` after every contact; a browser crash never loses progress
- **Session expiry mid-campaign:** detected per §6.9, never silently fails, never auto-resumes

### Security & Privacy

- **No data leaves the machine** except: (a) AI API calls to the chosen provider, (b) the actual messages sent to LinkedIn
- **API key storage caveat:** `chrome.storage.local` stores in plaintext. The user sees a one-time warning:
  > *"Your API key will be stored locally on this machine in plaintext. Anyone with access to your Chrome profile directory can read it. Do not use this tool on a shared computer."*
- Where feasible, prefer `chrome.storage.session` for the API key (cleared when the browser closes); offer as opt-in
- API key is never logged, never exported, never sent anywhere except the chosen AI provider
- CSV/PDF contents never transmitted except as part of AI personalization prompts
- No telemetry, no analytics, no remote error reporting

### Usability

- First-run setup completable by a non-developer in under 5 minutes
- Every destructive action (clear campaign, stop sending, delete template) requires confirmation
- Critical state (daily counter, warm-up phase, warning detected, session expired) visible from the popup without drilling into menus

### Compatibility

- Chrome 116+ (current Manifest V3 baseline)
- Also runs on Brave, Arc, Edge — anything Chromium-based that supports MV3 content scripts
- macOS 12+, Windows 10+, Ubuntu 22.04+

---

## 11. Technical Architecture

```
                ┌─────────────────────────────────────┐
                │   Chrome Extension (single repo)    │
                └─────────────────────────────────────┘
                              │
       ┌──────────────────────┼──────────────────────────┐
       │                      │                          │
       ▼                      ▼                          ▼
┌──────────────┐    ┌────────────────────┐    ┌──────────────────────────┐
│ Popup        │    │ Background SW      │    │ Content Script           │
│ ─────        │◄──►│ ─────              │◄──►│ ─────                    │
│ Upload       │    │ Tab management     │    │ Runs on linkedin.com/*   │
│ Template     │    │ State broker       │    │ Detects button state     │
│ Previews     │    │ chrome.alarms      │    │ Types message            │
│ Send queue   │    │ Daily counter      │    │ Clicks Send              │
│ Settings     │    │ reset @ midnight   │    │ Detects warnings         │
└──────┬───────┘    └────────────────────┘    └──────────┬───────────────┘
       │                                                  │
       ▼                                                  ▼
┌──────────────┐                                ┌─────────────────────────┐
│ AI Provider  │                                │ User's real LinkedIn    │
│ (Anthropic / │                                │ session — same cookies, │
│  OpenAI)     │                                │ same fingerprint, same  │
└──────────────┘                                │ everything as manual    │
                                                └─────────────────────────┘
```

### 11.1 Communication

- **Popup ↔ Content script:** `chrome.tabs.sendMessage(tabId, msg)` from popup; content script responds via `sendResponse` callback
- **Background ↔ Popup/Content script:** `chrome.runtime.sendMessage` and `chrome.runtime.onMessage`
- **Background as a relay** when the popup is closed during long campaigns (the popup may close mid-send; background keeps state)

### 11.2 Manifest V3 Permissions

| Permission | Why |
|---|---|
| `storage` | Persist campaigns, templates, counters, settings, queue state |
| `notifications` | Surface critical alerts (warning detected, session expired, daily limit) when the popup is closed |
| `alarms` | Schedule the daily counter reset at local midnight |
| `tabs` | Open and activate the contact's LinkedIn profile tab |
| `scripting` | Inject the content script into the LinkedIn tab |
| `host_permissions: ["https://*.linkedin.com/*"]` | Required for the content script to operate on LinkedIn |

### 11.3 File Layout

```
linkedin-outreach/
├── prd.md
├── CLAUDE.md
└── extension/
    ├── manifest.json                 # Manifest V3
    ├── popup.html                    # Popup shell
    ├── popup.js                      # Popup orchestration
    ├── background.js                 # Service worker — alarms, state broker
    ├── content-script.js             # LinkedIn DOM interaction
    ├── lib/
    │   ├── pdf.min.js                # PDF.js (bundled, no CDN)
    │   ├── pdf.worker.min.js
    │   └── (modules split out as the popup grows)
    └── icons/
        ├── icon16.png
        ├── icon48.png
        └── icon128.png
```

### 11.4 Selector Strategy

LinkedIn changes their DOM regularly. Selectors are infrastructure, not implementation detail.

- All LinkedIn selectors live in one place inside the content script (or a small `selectors.js` module). Logic files import named arrays — they never contain inline selector strings.
- Every critical element has **at least 3 fallback selectors** in priority order (ARIA role, class, text-content).
- A single `resolveSelector(selectorList)` helper walks the array and returns the first match.
- On any selector miss: log the miss with full context, classify the contact as `messaging_disabled` (or appropriate fallback), skip, and continue. Never guess.
- A "selector health check" runs on the first contact of every campaign — verify every critical element resolves before sending the first message.
- Selectors can be updated without rebuilding the extension (they live in a JS file the user can paste-update from a published gist).

---

## 12. Open Questions & Risks

### 12.1 LinkedIn ToS Risk

LinkedIn's User Agreement prohibits automated access. Even cautious, human-mimicking automation in a content script technically violates ToS.

**Mitigation:**
- Display a prominent required-acknowledgment disclaimer on first run:
  > *"This tool automates actions on LinkedIn. LinkedIn's Terms of Service prohibit automation. Use of this tool may result in restriction or termination of your LinkedIn account, even with the safety measures in place. By continuing, you accept this risk."*
- Hard-cap at 5/day. The detection threshold for personal-volume usage to 1st-degree connections is, in practice, much higher than this — but the ToS risk exists regardless of detection.
- Recommend warm, established accounts only.

### 12.2 LinkedIn DOM Changes

LinkedIn changes its DOM regularly. Selectors for the Message button, message dialog, send button, and button-state indicators break without warning, causing send failures or — worse — sending to the wrong field.

**Mitigation:**
- Multiple fallback selectors per element (§11.4)
- Read back message field value after typing; abort send on mismatch
- Selector health check on first contact of each campaign
- Fail loudly and stop on any selector miss
- Maintain selectors in a single file the user can paste-update without rebuilding

### 12.3 Content-Script Behavioral Detection

Even without a Playwright fingerprint, behavioral signals (typing too fast, clicking immediately after page load, identical inter-message timing) could in principle be flagged.

**Mitigation:**
- Per-keystroke delay 40–130ms randomized
- Micro-pauses at sentence boundaries
- Inter-message delay 60–180s randomized
- Brief profile scroll before opening message dialog
- Daily cap of 5 — small enough that random behavioral variation is more than enough cover

### 12.4 AI Message Quality

AI-generated personalization can be generic, flattering, or hallucinated (inventing facts).

**Mitigation:**
- Mandatory preview-and-approve gate (§5.4) is the primary defense
- Regenerate button lets the user iterate cheaply on weak outputs
- System prompt to the AI explicitly forbids: superlatives, invented facts, common cliché phrases ("I hope this finds you well", "synergies", "leverage")
- If `what_they_do` / `raised` / `investors` are all empty for a row, the AI produces a neutral non-personalized line rather than fabricating

### 12.5 Build & Distribution

- Cannot ship via Chrome Web Store (will be rejected for any LinkedIn automation)
- Distribution: unpacked extension via GitHub
- Limits the user base to technically comfortable users — aligned with target persona
- No build step for users; everything is plain HTML/CSS/JS that Chrome can load directly

---

## Appendix A: Glossary

- **Content script** — JavaScript that the extension injects into a regular web page; runs in the same context as the page's own scripts but in an isolated world
- **Manifest V3** — current Chrome Extension format; all new extensions use this
- **Service worker** — the background context for an MV3 extension; ephemeral, can be terminated and restarted by Chrome
- **`host_permissions`** — declaration in `manifest.json` listing the URLs an extension can interact with via content scripts and `chrome.scripting`
- **PDF.js** — Mozilla's JavaScript PDF renderer; we use it client-side to parse uploaded PDFs into positioned text
- **1st-degree connection** — A LinkedIn user the operator is directly connected to
- **Warm account** — A LinkedIn account with regular human activity (logins, browsing, posts) over recent months

---

## Appendix B: Build Order

The order trades implementation risk for user value. Earlier phases produce a usable tool even if later phases are never built.

1. ✅ **File parsing (CSV + PDF) → JSON** — done
2. **Validate, normalize, persist contacts** — current step. Canonical schema, alias mapping, validation, dedup, storage, preview table.
3. **Template editor + variable substitution** — textarea + saved templates + live preview against the first contact
4. **AI integration + preview generation** — API key entry with security warning, per-row generation, character counter, regenerate button
5. **Per-contact approval UI** — Approve / Edit / Regenerate / Skip; persist preview state
6. **Content-script spike: detect message button state on a real LinkedIn profile** — read-only, no send. Confirms the selector strategy works.
7. **Content-script: send a single test message end-to-end** — humanized typing, click Send, verify, halt-on-mismatch
8. **Send queue UI with daily counter, Pause/Resume/Stop**
9. **Inter-message delay + active-hours window**
10. **Warning detection + session expiry detection + halt logic**
11. **Result logging + CSV export**
12. **First-run flow + ToS disclaimer + API key warning**
13. **End-to-end test on a real account: 1 contact, then 5**

---

## Living Notes

> Append phase-by-phase observations here as you build.

- **Phase 1 notes (file parsing):** Built CSV parser inline (no PapaParse). PDF parser uses PDF.js with positioned text extraction — groups items by y-coordinate into rows, uses header row's x-positions as column boundaries, buckets every other item to nearest column. Multi-page tables with the same header layout extend the same part; tables with different headers (e.g., left vs right halves of an exported spreadsheet) are tracked as separate parts and merged by row-number column.
- **Phase 2 notes:**
- **Phase 3 notes:**
