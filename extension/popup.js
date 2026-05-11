// LinkedIn Outreach — popup.
// Step 1: parse CSV/PDF, normalize to canonical contacts, validate, persist.

// ============================================================
// Config (PRD §4, §5.2, §6.4)
// ============================================================

const STORAGE_KEY            = 'campaign';
const TEMPLATES_KEY          = 'templates';
const ACTIVE_TEMPLATE_KEY    = 'active_template_id';
const ROW_HARD_CAP           = 200;
const MESSAGE_CHAR_LIMIT     = 1900;
const MESSAGE_CHAR_WARNING   = 1700;
const SAVE_DEBOUNCE_MS       = 250;

const DEFAULT_TEMPLATE_BODY =
`Hi {{name}},

Saw you're {{role}} at {{company}}. {{ai_personalization}}

Would love to compare notes — open to a 15-min call next week?

— Bilguun`;

// Header alias map: canonical field name → list of accepted source headers.
// Source headers are normalized (lowercased, spaces → underscores, punctuation stripped)
// before lookup.
const HEADER_ALIASES = {
  company:      ['company', 'company_name', 'org', 'organization', 'employer', 'workplace'],
  name:         ['name', 'founder_ceo', 'founder_ceo_name', 'founder', 'full_name', 'fullname',
                 'contact', 'contact_name', 'person', 'person_name', 'first_last', 'firstname_lastname'],
  role:         ['role', 'title', 'position', 'job_title', 'job'],
  linkedin_url: ['linkedin_url', 'linkedin', 'url', 'profile_url', 'profile',
                 'linkedin_profile', 'profile_link', 'linkedin_link', 'link'],
  what_they_do: ['what_they_do', 'description', 'company_description', 'business', 'about'],
  raised:       ['raised', 'funding', 'amount_raised', 'funding_amount', 'capital'],
  investors:    ['investors', 'investor', 'investor_s', 'backers', 'vc', 'vcs'],
};

const REQUIRED_FIELDS = ['company', 'name', 'role', 'linkedin_url'];

// Names that are pre-research markers, not real contacts.
const PLACEHOLDER_NAME_PATTERNS = [
  /search on linkedin/i,
  /find founder/i,
  /^unknown$/i,
  /^tbd$/i,
];

// Any linkedin.com URL (profile, company, search, group, etc.).
// Sub-type detection (profile vs search) happens later when sending —
// we accept anything that points at LinkedIn at validation time.
const LINKEDIN_URL_PATTERN = /^https?:\/\/([a-z]+\.)?linkedin\.com\/.+/i;

// ============================================================
// DOM refs
// ============================================================

const fileInput     = document.getElementById('file');
const fileReplace   = document.getElementById('file-replace');
const emptyView     = document.getElementById('empty-view');
const loadedView    = document.getElementById('loaded-view');
const summaryEl     = document.getElementById('summary');
const tableBody     = document.getElementById('table-body');
const skippedEl     = document.getElementById('skipped');
const skippedList   = document.getElementById('skipped-list');
const skippedCount  = document.getElementById('skipped-count');
const clearBtn      = document.getElementById('clear-btn');
const replaceBtn    = document.getElementById('replace-btn');
const errorEl       = document.getElementById('error');

// Template editor
const templateSection = document.getElementById('template-section');
const templateSelect  = document.getElementById('template-select');
const templateNewBtn  = document.getElementById('template-new');
const templateDelBtn  = document.getElementById('template-delete');
const templateBody    = document.getElementById('template-body');
const charCount       = document.getElementById('char-count');
const saveIndicator   = document.getElementById('save-indicator');
const previewBody     = document.getElementById('preview-body');
const previewTarget   = document.getElementById('preview-target');

// Send + halt banner
const sendBtn         = document.getElementById('send-btn');
const sendStatusEl    = document.getElementById('send-status');
const haltBanner      = document.getElementById('halt-banner');
const haltReasonEl    = document.getElementById('halt-reason');
const resetHaltBtn    = document.getElementById('reset-halt-btn');

// Template editor state
let templates         = {};   // id → { name, body, updated_at }
let activeTemplateId  = null;
let firstContact      = null; // contact used for live preview
let isHalted          = false;

// ============================================================
// PDF.js worker
// ============================================================

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    chrome.runtime.getURL('lib/pdf.worker.min.js');
}

// ============================================================
// Init: restore campaign on popup open
// ============================================================

// Storage availability check. Manifest declares "storage" permission, but if
// the extension was loaded before that permission was added, Chrome may not
// expose chrome.storage until the extension is reloaded.
const STORAGE_AVAILABLE = !!(window.chrome?.storage?.local);

if (!STORAGE_AVAILABLE) {
  errorEl.textContent =
    'chrome.storage is unavailable. Reload the extension at chrome://extensions ' +
    '(click the ↻ refresh icon on the extension card), then close and reopen this popup.';
  // Don't disable upload entirely — let parsing still work, just skip persistence.
}

(async function init() {
  try {
    if (!STORAGE_AVAILABLE) { renderEmpty(); return; }
    await initTemplates();
    const campaign = await getCampaign();
    if (campaign && (campaign.contacts?.length || campaign.skipped?.length)) {
      renderLoaded(campaign);
    } else {
      renderEmpty();
    }
  } catch (err) {
    console.error('init failed', err);
    renderEmpty();
  }
})();

// ============================================================
// Event handlers
// ============================================================

fileInput.addEventListener('change', () => handleUpload(fileInput));
fileReplace.addEventListener('change', () => handleUpload(fileReplace));
replaceBtn.addEventListener('click', () => fileReplace.click());

clearBtn.addEventListener('click', async () => {
  if (!confirm('Clear the current campaign? Contacts will be removed from local storage.')) return;
  await clearCampaign();
  fileInput.value = '';
  fileReplace.value = '';
  renderEmpty();
});

async function handleUpload(input) {
  errorEl.textContent = '';
  const file = input.files?.[0];
  if (!file) return;

  try {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let parsed;

    if (ext === 'pdf' || file.type === 'application/pdf') {
      parsed = await parsePdf(file);
    } else {
      parsed = await parseCsvFile(file);
    }

    const { records: rawRecords, columns: detectedColumns = [] } = parsed;

    if (!rawRecords.length) {
      errorEl.textContent = 'No rows found in the file.';
      return;
    }

    const { valid, skipped } = processRecords(rawRecords);

    const campaign = {
      filename: file.name,
      uploaded_at: new Date().toISOString(),
      counts: {
        total: rawRecords.length,
        valid: valid.length,
        skipped: skipped.length,
      },
      detected_columns: detectedColumns,
      column_mapping: buildColumnMapping(detectedColumns),
      contacts: valid,
      skipped,
    };

    if (STORAGE_AVAILABLE) {
      await saveCampaign(campaign);
    } else {
      // Without storage we can still show the result for the current popup session.
      console.warn('Storage unavailable; campaign not persisted.');
    }
    renderLoaded(campaign);
    input.value = ''; // allow re-uploading the same file
  } catch (err) {
    errorEl.textContent = `Could not parse file: ${err.message}`;
    console.error(err);
  }
}

// ============================================================
// Render
// ============================================================

function renderEmpty() {
  emptyView.style.display = 'block';
  loadedView.style.display = 'none';
  templateSection.style.display = 'none';
  firstContact = null;
}

function renderLoaded(campaign) {
  emptyView.style.display = 'none';
  loadedView.style.display = 'flex';

  summaryEl.innerHTML =
    `<strong>${escapeHtml(campaign.filename)}</strong> · ` +
    `${campaign.counts.valid} valid · ${campaign.counts.skipped} skipped · ` +
    `uploaded ${formatDate(campaign.uploaded_at)}`;

  // Detected columns diagnostic
  const colsEl = document.getElementById('detected-cols');
  if (colsEl) {
    if (campaign.detected_columns?.length) {
      const mapping = campaign.column_mapping || {};
      const html = campaign.detected_columns
        .filter(c => c) // skip empty (e.g. "#" column)
        .map(c => {
          const m = mapping[c];
          return m
            ? `<span class="col-ok"><code>${escapeHtml(c)}</code> → ${escapeHtml(m)}</span>`
            : `<span class="col-skip"><code>${escapeHtml(c)}</code> → (unrecognized)</span>`;
        })
        .join(' · ');
      colsEl.innerHTML = `<strong>Detected columns:</strong> ${html}`;
      colsEl.style.display = 'block';
    } else {
      colsEl.style.display = 'none';
    }
  }

  // Empty-results message when 0 valid
  const emptyResults = document.getElementById('empty-results');
  if (campaign.counts.valid === 0) {
    emptyResults.style.display = 'block';
    document.querySelector('.table-wrap').style.display = 'none';
  } else {
    emptyResults.style.display = 'none';
    document.querySelector('.table-wrap').style.display = 'block';
  }

  // Table
  tableBody.innerHTML = '';
  for (const c of campaign.contacts) {
    const tr = document.createElement('tr');
    tr.appendChild(td(c.company));
    tr.appendChild(td(c.name));
    tr.appendChild(td(c.role));

    const urlTd = document.createElement('td');
    const a = document.createElement('a');
    a.href = c.linkedin_url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = c.linkedin_url.replace(/^https?:\/\/(www\.)?/, '');
    urlTd.appendChild(a);
    tr.appendChild(urlTd);

    tableBody.appendChild(tr);
  }

  // Template editor: visible only if we have at least one valid contact to preview against
  if (campaign.contacts?.length) {
    firstContact = campaign.contacts[0];
    templateSection.style.display = 'flex';
    updatePreview();
  } else {
    firstContact = null;
    templateSection.style.display = 'none';
  }

  // Skipped section — show raw values for each skipped row so user can debug
  if (campaign.skipped?.length) {
    skippedEl.style.display = 'block';
    skippedEl.open = campaign.counts.valid === 0; // auto-open if 0 valid
    skippedCount.textContent = campaign.skipped.length;
    skippedList.innerHTML = '';
    for (const s of campaign.skipped) {
      const li = document.createElement('li');
      const ident = s.raw.company || s.raw.name || s.raw.linkedin_url || '(unnamed row)';
      const headLine = document.createElement('div');
      headLine.innerHTML = `<strong>${escapeHtml(ident)}</strong> — ${escapeHtml(s.reason)}`;
      li.appendChild(headLine);

      // Compact dump of the raw row's non-empty values
      const detail = document.createElement('div');
      detail.className = 'raw-detail';
      detail.textContent = formatRaw(s.raw);
      li.appendChild(detail);

      skippedList.appendChild(li);
    }
  } else {
    skippedEl.style.display = 'none';
  }
}

function formatRaw(raw) {
  return Object.entries(raw)
    .filter(([k, v]) => k && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${truncate(v, 60)}`)
    .join('  ·  ');
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function td(text) {
  const el = document.createElement('td');
  el.textContent = text || '';
  return el;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

// ============================================================
// Storage (chrome.storage.local — promisified)
// ============================================================

function getCampaign() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) =>
      resolve(result[STORAGE_KEY] || null)
    );
  });
}

function saveCampaign(campaign) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: campaign }, resolve);
  });
}

function clearCampaign() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([STORAGE_KEY], resolve);
  });
}

// ============================================================
// Normalize → validate → dedup
// ============================================================

/**
 * Convert raw records (header→value maps) into validated canonical contacts.
 * Returns { valid: Contact[], skipped: { raw, reason }[] }.
 */
function processRecords(rawRecords) {
  const valid = [];
  const skipped = [];
  const seenUrls = new Set();

  for (const raw of rawRecords) {
    if (valid.length >= ROW_HARD_CAP) {
      skipped.push({ raw, reason: `Over ${ROW_HARD_CAP}-row hard cap` });
      continue;
    }

    const canonical = mapToCanonical(raw);

    // Required fields present?
    const missing = REQUIRED_FIELDS.filter((f) => !canonical[f]);
    if (missing.length) {
      skipped.push({
        raw,
        reason: `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      });
      continue;
    }

    // Placeholder name?
    if (PLACEHOLDER_NAME_PATTERNS.some((p) => p.test(canonical.name))) {
      skipped.push({
        raw,
        reason: `Founder name is a placeholder ("${canonical.name}") — find the real contact first`,
      });
      continue;
    }

    // Clean LinkedIn URL.
    canonical.linkedin_url = cleanLinkedInUrl(canonical.linkedin_url);

    if (!LINKEDIN_URL_PATTERN.test(canonical.linkedin_url)) {
      skipped.push({
        raw,
        reason: `Invalid LinkedIn URL: "${canonical.linkedin_url}"`,
      });
      continue;
    }

    // Dedup
    const urlKey = canonical.linkedin_url.toLowerCase().replace(/\/$/, '');
    if (seenUrls.has(urlKey)) {
      skipped.push({
        raw,
        reason: `Duplicate LinkedIn URL (kept first): ${canonical.linkedin_url}`,
      });
      continue;
    }
    seenUrls.add(urlKey);

    valid.push(canonical);
  }

  return { valid, skipped };
}

/**
 * Map a raw record (whatever headers were in the source) to the canonical
 * Contact shape, using HEADER_ALIASES.
 */
function mapToCanonical(raw) {
  const out = {};
  for (const [canonicalKey, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const v = raw[alias];
      if (v !== undefined && String(v).trim() !== '') {
        out[canonicalKey] = String(v).trim();
        break;
      }
    }
  }
  return out;
}

/**
 * Given a list of normalized source column names, figure out which canonical
 * field each one maps to (or null if unrecognized). Used for diagnostics.
 */
function buildColumnMapping(detectedColumns) {
  const mapping = {};
  for (const col of detectedColumns) {
    let mappedTo = null;
    for (const [canonicalKey, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(col)) { mappedTo = canonicalKey; break; }
    }
    mapping[col] = mappedTo;
  }
  return mapping;
}

/**
 * Strip "(search to verify)", "(find founder)", and similar parenthetical
 * annotations from a LinkedIn URL. Add https:// if missing.
 */
function cleanLinkedInUrl(url) {
  let cleaned = String(url).split(/\s*\(/)[0].trim();
  if (!/^https?:\/\//i.test(cleaned)) cleaned = 'https://' + cleaned;
  return cleaned;
}

// ============================================================
// CSV parser (RFC-4180-ish)
// ============================================================

async function parseCsvFile(file) {
  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) return { records: [], columns: [] };

  const [rawHeader, ...dataRows] = rows;
  const columns = rawHeader.map(normalizeHeader);

  const records = dataRows
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) =>
      Object.fromEntries(columns.map((h, i) => [h, (r[i] ?? '').trim()]))
    );

  return { records, columns };
}

function normalizeHeader(h) {
  return String(h)
    .trim()
    .toLowerCase()
    .replace(/[\/\s\-]+/g, '_')   // slashes, whitespace, hyphens → underscore
    .replace(/[^a-z0-9_]/g, '')   // strip everything else (parens, $, etc.)
    .replace(/_+/g, '_')          // collapse repeats
    .replace(/^_+|_+$/g, '');     // trim leading/trailing
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else { cell += ch; }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') { continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ============================================================
// PDF parser (positioned text via PDF.js)
// ============================================================

async function parsePdf(file) {
  if (!window.pdfjsLib) throw new Error('PDF.js failed to load.');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const tableParts = [];
  let currentPart = null;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();

    const items = tc.items
      .filter((it) => it.str && it.str.trim() !== '')
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width,
      }));
    if (!items.length) continue;

    const rows = groupIntoRows(items);
    const headerIdx = rows.findIndex((r) => looksLikeHeader(r));
    if (headerIdx < 0) continue;

    const headerRow = rows[headerIdx];
    const columnXs    = headerRow.map((it) => it.x);
    const columnNames = headerRow.map((it) => normalizeHeader(it.str));

    const partKey = columnNames.join('|');
    if (!currentPart || currentPart.key !== partKey) {
      currentPart = { key: partKey, columns: columnNames, columnXs, rows: [] };
      tableParts.push(currentPart);
    }

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const record = bucketRowIntoColumns(rows[i], currentPart.columnXs, currentPart.columns);
      if (Object.values(record).some((v) => v !== '')) {
        currentPart.rows.push(record);
      }
    }
  }

  if (!tableParts.length) return { records: [], columns: [] };

  // Merge multi-part tables (e.g., wide spreadsheet split into left/right halves)
  // by row-id column if all parts share one.
  const mergedColumns = [];
  const seen = new Set();
  for (const part of tableParts)
    for (const c of part.columns)
      if (!seen.has(c)) { seen.add(c); mergedColumns.push(c); }

  const rowIdKey = pickRowIdKey(mergedColumns);
  let records;

  if (rowIdKey && tableParts.every((p) => p.columns.includes(rowIdKey))) {
    const merged = new Map();
    for (const part of tableParts) {
      for (const r of part.rows) {
        const id = r[rowIdKey];
        if (!id) continue;
        const cur = merged.get(id) || {};
        merged.set(id, { ...cur, ...r });
      }
    }
    records = [...merged.values()].sort(
      (a, b) => Number(a[rowIdKey]) - Number(b[rowIdKey])
    );
  } else {
    records = tableParts.flatMap((p) => p.rows);
  }

  return { records, columns: mergedColumns };
}

function looksLikeHeader(rowItems) {
  if (rowItems[0]?.str.trim() === '#') return true;
  const text = rowItems.map((it) => it.str.trim().toLowerCase()).join(' ');
  return /\b(company|founder|linkedin|role|investor|raised|name)\b/.test(text);
}

function pickRowIdKey(columns) {
  if (columns.includes('')) return ''; // "#" normalizes to empty string
  if (columns.includes('row')) return 'row';
  if (columns.includes('id')) return 'id';
  if (columns.includes('no')) return 'no';
  return null;
}

/**
 * Group PDF text items into table rows.
 *
 * Strategy — two-pass anchor-based clustering:
 *   1. Coarsely cluster by y-coordinate (tight tolerance) to find a header row.
 *   2. The leftmost item of the header defines the "row-number" column.
 *      Every text item below the header that sits in that column is an ANCHOR
 *      — its y becomes one row's centerline.
 *   3. Every other item is bucketed to the nearest anchor's row by y-distance,
 *      with a tolerance based on actual row spacing (median of anchor gaps × 0.55).
 *
 * This is robust to:
 *   - Multi-line wrapped cell content (e.g., "CEO & Co-" / "Founder") — both
 *     wrapped fragments fall within the row's tolerance and merge correctly.
 *   - Slight baseline jitter between cells in the same row.
 *   - Documents where row spacing varies — tolerance adapts to the document's
 *     own row spacing.
 */
function groupIntoRows(items) {
  if (!items.length) return [];

  // Pass 1: coarse y-cluster to locate the header row.
  const COARSE_TOL = 6;
  const coarse = clusterByY(items, COARSE_TOL);
  const headerIdx = coarse.findIndex(looksLikeHeader);

  // No header? Best-effort fall back to the coarse clustering.
  if (headerIdx < 0) return coarse.map(formatRow);

  const headerRow = coarse[headerIdx];
  const headerY   = Math.max(...headerRow.map((it) => it.y));
  const leftmostX = Math.min(...headerRow.map((it) => it.x));

  // Pass 2: anchor items are everything in (or very near) the leftmost
  // column, below the header.
  const ANCHOR_TOL_X = 30;
  const anchors = items
    .filter((it) => it.y < headerY - 2 && Math.abs(it.x - leftmostX) < ANCHOR_TOL_X)
    .sort((a, b) => b.y - a.y); // top → bottom in PDF coords

  // Not enough anchors? Fall back.
  if (anchors.length < 2) return coarse.map(formatRow);

  // Determine row tolerance from actual row spacing in this document.
  const gaps = [];
  for (let i = 1; i < anchors.length; i++) {
    gaps.push(anchors[i - 1].y - anchors[i].y);
  }
  gaps.sort((a, b) => a - b);
  const typicalGap = gaps[Math.floor(gaps.length / 2)] || 25;
  const tolerance  = typicalGap * 0.55;

  // Bucket every non-anchor item below the header into its nearest row.
  const anchorSet = new Set(anchors);
  const dataRows  = anchors.map((a) => [a]);

  for (const it of items) {
    if (it.y >= headerY - 2) continue;
    if (anchorSet.has(it)) continue;

    let bestIdx = -1;
    let bestD   = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      const d = Math.abs(it.y - anchors[i].y);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestD <= tolerance) {
      dataRows[bestIdx].push(it);
    }
    // else: orphan (between rows or outside any row's tolerance) — discard
  }

  return [formatRow(headerRow), ...dataRows.map(formatRow)];
}

/** Cluster items by y-coordinate using a fixed tolerance. */
function clusterByY(items, tol) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let cur = null;
  let curY = null;
  for (const it of sorted) {
    if (cur === null || (curY - it.y) > tol) {
      cur = []; curY = it.y; rows.push(cur);
    }
    cur.push(it);
  }
  return rows;
}

/** Sort a row left-to-right and stitch together items that touch on x. */
function formatRow(row) {
  return mergeWrappedFragments([...row].sort((a, b) => a.x - b.x));
}

function mergeWrappedFragments(row) {
  const MERGE_GAP = 3;
  const out = [];
  for (const it of row) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap < MERGE_GAP) {
        prev.str = (prev.str + ' ' + it.str).replace(/\s+/g, ' ').trim();
        prev.w = (it.x + it.w) - prev.x;
        continue;
      }
    }
    out.push({ ...it });
  }
  return out;
}

function bucketRowIntoColumns(rowItems, columnXs, columnNames) {
  const buckets = columnNames.map(() => []);
  for (const it of rowItems) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < columnXs.length; i++) {
      const dist = Math.abs(it.x - columnXs[i]);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    buckets[bestIdx].push(it.str);
  }
  const record = {};
  for (let i = 0; i < columnNames.length; i++) {
    record[columnNames[i]] = buckets[i].join(' ').replace(/\s+/g, ' ').trim();
  }
  return record;
}

// ============================================================
// Template editor (step 2)
// ============================================================

/**
 * Read templates + active id from storage, bootstrap a default if empty,
 * and wire the UI.
 */
async function initTemplates() {
  templates        = (await getStored(TEMPLATES_KEY))       || {};
  activeTemplateId = (await getStored(ACTIVE_TEMPLATE_KEY)) || null;

  // First-run: create a starter template
  if (!Object.keys(templates).length) {
    templates['default'] = {
      name: 'Default',
      body: DEFAULT_TEMPLATE_BODY,
      updated_at: new Date().toISOString(),
    };
    activeTemplateId = 'default';
    await setStored(TEMPLATES_KEY, templates);
    await setStored(ACTIVE_TEMPLATE_KEY, activeTemplateId);
  }

  // Recover gracefully if the saved active id no longer exists
  if (!activeTemplateId || !templates[activeTemplateId]) {
    activeTemplateId = Object.keys(templates)[0];
    await setStored(ACTIVE_TEMPLATE_KEY, activeTemplateId);
  }

  populateTemplateSelector();
  loadActiveTemplateIntoEditor();
  wireTemplateEvents();
}

function populateTemplateSelector() {
  templateSelect.innerHTML = '';
  // Stable order: alphabetical by name
  const entries = Object.entries(templates)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  for (const [id, tpl] of entries) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = tpl.name;
    if (id === activeTemplateId) opt.selected = true;
    templateSelect.appendChild(opt);
  }
}

function loadActiveTemplateIntoEditor() {
  const tpl = templates[activeTemplateId];
  if (!tpl) return;
  templateBody.value = tpl.body;
  updatePreview();
}

// ────────────────────────────────────────────────────────────
// Variable substitution (PRD §5.2)
// ────────────────────────────────────────────────────────────

/**
 * Extract a sensible first name from a full name. Strips common titles.
 * Edge-case names that don't fit can be edited per-message in step 4.
 */
function extractFirstName(fullName) {
  if (!fullName) return '';
  const cleaned = String(fullName).replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '').trim();
  const first   = cleaned.split(/\s+/)[0];
  return first || fullName;
}

/**
 * Substitute every `{{variable}}` reference in the template with values
 * from the contact. Variables not in the canonical set are left untouched
 * so typos like `{{Name}}` are visible in the preview.
 */
function fillTemplate(template, contact) {
  if (!contact) return template;
  return template
    .replace(/\{\{name\}\}/g,               extractFirstName(contact.name))
    .replace(/\{\{full_name\}\}/g,          contact.name      || '')
    .replace(/\{\{company\}\}/g,            contact.company   || '')
    .replace(/\{\{role\}\}/g,               contact.role      || '')
    .replace(/\{\{ai_personalization\}\}/g, '[AI personalization — added in step 3]');
}

// ────────────────────────────────────────────────────────────
// Preview + char count
// ────────────────────────────────────────────────────────────

function updatePreview() {
  if (!firstContact) {
    previewTarget.textContent  = '';
    previewBody.textContent    = '(upload contacts to see a preview)';
    previewBody.classList.add('preview-empty');
    charCount.textContent      = `${templateBody.value.length} / ${MESSAGE_CHAR_LIMIT}`;
    charCount.dataset.state    = 'ok';
    updateSendButton();
    return;
  }

  const filled = fillTemplate(templateBody.value, firstContact);

  previewBody.classList.remove('preview-empty');
  previewBody.textContent = filled || '(empty)';
  previewTarget.textContent =
    `for ${firstContact.name} at ${firstContact.company}`;

  const len = filled.length;
  charCount.textContent = `${len} / ${MESSAGE_CHAR_LIMIT}`;
  charCount.dataset.state =
    len >= MESSAGE_CHAR_LIMIT ? 'over'
  : len >= MESSAGE_CHAR_WARNING ? 'warning'
  : 'ok';

  updateSendButton();
}

function updateSendButton() {
  if (isHalted) {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Send (halted)';
    return;
  }
  if (!firstContact) {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Send';
    return;
  }
  const filled = fillTemplate(templateBody.value, firstContact);
  if (!filled.trim()) {
    sendBtn.disabled = true;
    sendBtn.textContent = `Send (empty message)`;
    return;
  }
  if (filled.length > MESSAGE_CHAR_LIMIT) {
    sendBtn.disabled = true;
    sendBtn.textContent = `Send (over ${MESSAGE_CHAR_LIMIT} chars)`;
    return;
  }
  sendBtn.disabled = false;
  sendBtn.textContent = `Send to ${extractFirstName(firstContact.name)}`;
}

// ────────────────────────────────────────────────────────────
// Auto-save
// ────────────────────────────────────────────────────────────

let saveTimer = null;

function flashSaved() {
  saveIndicator.classList.add('show');
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => saveIndicator.classList.remove('show'), 800);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(commitActiveTemplate, SAVE_DEBOUNCE_MS);
}

async function commitActiveTemplate() {
  if (!activeTemplateId || !templates[activeTemplateId]) return;
  templates[activeTemplateId].body       = templateBody.value;
  templates[activeTemplateId].updated_at = new Date().toISOString();
  await setStored(TEMPLATES_KEY, templates);
  flashSaved();
}

// ────────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────────

function wireTemplateEvents() {
  // Live preview + auto-save on edit
  templateBody.addEventListener('input', () => {
    updatePreview();
    scheduleSave();
  });

  // Switch templates — save current before loading the new one
  templateSelect.addEventListener('change', async () => {
    clearTimeout(saveTimer);
    await commitActiveTemplate();
    activeTemplateId = templateSelect.value;
    await setStored(ACTIVE_TEMPLATE_KEY, activeTemplateId);
    loadActiveTemplateIntoEditor();
  });

  // New template — uses current textarea content as the body
  templateNewBtn.addEventListener('click', async () => {
    const name = prompt('Name for the new template:');
    if (!name?.trim()) return;
    const id = uniqueTemplateId(slugify(name));
    templates[id] = {
      name: name.trim(),
      body: templateBody.value,
      updated_at: new Date().toISOString(),
    };
    activeTemplateId = id;
    await setStored(TEMPLATES_KEY, templates);
    await setStored(ACTIVE_TEMPLATE_KEY, id);
    populateTemplateSelector();
  });

  // Delete the active template
  templateDelBtn.addEventListener('click', async () => {
    if (Object.keys(templates).length <= 1) {
      alert('Cannot delete the last template. Edit this one instead.');
      return;
    }
    const t = templates[activeTemplateId];
    if (!confirm(`Delete template "${t.name}"?`)) return;
    delete templates[activeTemplateId];
    activeTemplateId = Object.keys(templates)[0];
    await setStored(TEMPLATES_KEY, templates);
    await setStored(ACTIVE_TEMPLATE_KEY, activeTemplateId);
    populateTemplateSelector();
    loadActiveTemplateIntoEditor();
  });

  // Variable chips: click to insert at cursor
  for (const chip of document.querySelectorAll('.var-chip')) {
    chip.addEventListener('click', () => {
      const v = chip.dataset.var;
      if (!v) return;
      insertAtCursor(templateBody, v);
      updatePreview();
      scheduleSave();
    });
  }
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end   = textarea.selectionEnd   ?? textarea.value.length;
  const v     = textarea.value;
  textarea.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = pos;
  textarea.focus();
}

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || ('template-' + Date.now());
}

function uniqueTemplateId(base) {
  if (!templates[base]) return base;
  let i = 2;
  while (templates[`${base}-${i}`]) i++;
  return `${base}-${i}`;
}

// ────────────────────────────────────────────────────────────
// Generic chrome.storage.local helpers (used by template module)
// ────────────────────────────────────────────────────────────

function getStored(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => resolve(res[key]));
  });
}

function setStored(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

// ============================================================
// Send (PRD §5.5, §5.6)
// ============================================================
//
// Orchestration lives in the background service worker so the popup
// closing doesn't kill the send. Popup's job:
//   1. Send a request to the background.
//   2. Listen for progress updates (only delivered while popup is open).
//   3. On every popup open, show the last completed send's result.

sendBtn.addEventListener('click', async () => {
  if (!firstContact) return;

  const message = fillTemplate(templateBody.value, firstContact);
  if (!message.trim()) return;

  sendBtn.disabled = true;
  showSendStatus('Sending…', 'pending');

  // Fire and forget — background handles the rest. We may or may not
  // get a response here depending on whether the popup stays open.
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'send_to_contact',
      url: firstContact.linkedin_url,
      message,
      contactName: firstContact.name,
    });

    if (response?.ok) {
      showSendStatus('✓ ' + (response.reason || 'Message sent'), 'ok');
    } else if (response) {
      showSendStatus('✗ ' + (response.reason || 'Send failed'), 'err');
    }
    // else: popup closed before background replied — final result is in storage
  } catch (err) {
    // Often happens when popup closes mid-send. Result still gets persisted
    // by background; we'll show it on next popup open.
    console.warn('[send] message channel closed:', err);
  } finally {
    updateSendButton();
  }
});

// Live progress updates from the background (only fire while popup is open)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'send_progress') {
    showSendStatus(msg.text, msg.kind || 'pending');
  }
});

// On popup open, hydrate halt state and show the last send's result.
(async function hydrateSendState() {
  try {
    const state = await new Promise((r) =>
      chrome.storage.local.get(['halted', 'last_send_result', 'consecutive_failures'], r)
    );

    if (state.halted) {
      isHalted = true;
      haltBanner.style.display = 'flex';
      haltReasonEl.textContent = state.halted.reason || '';
    } else {
      isHalted = false;
      haltBanner.style.display = 'none';
    }
    updateSendButton();

    // Show last completed send (within 30 min) even if popup was closed when it finished
    const last = state.last_send_result;
    if (last) {
      const ageMs = Date.now() - new Date(last.when).getTime();
      if (ageMs <= 30 * 60 * 1000) {
        const prefix = last.ok ? '✓ ' : '✗ ';
        const ago = humanAgo(ageMs);
        const fc = state.consecutive_failures || 0;
        const failTrail = (!last.ok && fc > 0 && !state.halted) ? ` (${fc}/3 failures)` : '';
        showSendStatus(`${prefix}${last.contactName || 'last send'} — ${last.reason || ''}${failTrail} (${ago})`, last.ok ? 'ok' : 'err');
      }
    }
  } catch (_) {}
})();

// Reset halt
resetHaltBtn?.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'reset_halt' });
  } catch (_) {}
  isHalted = false;
  haltBanner.style.display = 'none';
  showSendStatus('Halt cleared. You can send again.', 'pending');
  updateSendButton();
});

function humanAgo(ms) {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return Math.round(ms / 60_000) + ' min ago';
  return Math.round(ms / 3_600_000) + ' hr ago';
}

function showSendStatus(text, kind) {
  sendStatusEl.textContent = text;
  sendStatusEl.className = 'send-status show ' + kind;
}

