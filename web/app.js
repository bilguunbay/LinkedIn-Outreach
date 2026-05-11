const state = {
  contacts: [],
  statuses: new Map(),
  contactJobs: new Map(),
  jobs: new Map(),
  primaryJobId: null,
  settings: null,
  safety: null,
  activeJobs: new Map(),
};

const els = {
  csvFile: document.getElementById('csv-file'),
  uploadSummary: document.getElementById('upload-summary'),
  template: document.getElementById('message-template'),
  preview: document.getElementById('message-preview'),
  contactsBody: document.getElementById('contacts-body'),
  queueSubtitle: document.getElementById('queue-subtitle'),
  log: document.getElementById('activity-log'),
  todayCount: document.getElementById('today-count'),
  activeHours: document.getElementById('active-hours'),
  delayRange: document.getElementById('delay-range'),
  failureCount: document.getElementById('failure-count'),
  queueState: document.getElementById('queue-state'),
  jobPanel: document.getElementById('job-panel'),
  jobTitle: document.getElementById('job-title'),
  jobPhase: document.getElementById('job-phase'),
  jobElapsed: document.getElementById('job-elapsed'),
  jobLastUpdate: document.getElementById('job-last-update'),
  jobQueuePosition: document.getElementById('job-queue-position'),
  jobGuidance: document.getElementById('job-guidance'),
  haltState: document.getElementById('halt-state'),
  haltBox: document.getElementById('halt-box'),
  settingsModal: document.getElementById('settings-modal'),
  settingDailyCap: document.getElementById('setting-daily-cap'),
  settingActiveHours: document.getElementById('setting-active-hours'),
  settingMinDelay: document.getElementById('setting-min-delay'),
  settingMaxDelay: document.getElementById('setting-max-delay'),
  settingAllowRepeat: document.getElementById('setting-allow-repeat'),
  settingAllowDuplicateMessage: document.getElementById('setting-allow-duplicate-message'),
  riskAck: document.getElementById('risk-ack'),
};

init();

async function init() {
  bindEvents();
  await refreshSafety();
  renderContacts();
  renderPreview();
  setInterval(renderJobPanel, 1000);
}

function bindEvents() {
  els.csvFile.addEventListener('change', handleCsv);
  els.template.addEventListener('input', renderPreview);
  document.querySelectorAll('[data-var]').forEach((button) => {
    button.addEventListener('click', () => insertAtCursor(els.template, button.dataset.var));
  });
  document.getElementById('refresh-safety').addEventListener('click', refreshSafety);
  document.getElementById('reset-halt').addEventListener('click', resetHalt);
  document.getElementById('clear-log').addEventListener('click', () => {
    els.log.textContent = 'Ready.';
  });

  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('close-settings').addEventListener('click', closeSettings);
  document.getElementById('cancel-settings').addEventListener('click', closeSettings);
  document.getElementById('save-settings').addEventListener('click', saveSettings);
}

async function handleCsv(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const { contacts, skipped } = parseContactsCsv(text);
  state.contacts = contacts;
  state.statuses = new Map(contacts.map((contact) => [contact.id, { kind: 'ready', text: 'Ready' }]));
  els.uploadSummary.textContent = `${contacts.length} ready contact${contacts.length === 1 ? '' : 's'}${skipped.length ? `, ${skipped.length} skipped` : ''}.`;
  appendLog(`Loaded ${file.name}: ${contacts.length} ready, ${skipped.length} skipped.`);
  for (const skip of skipped) appendLog(`Skipped row ${skip.row}: ${skip.reason}`);
  renderContacts();
  renderPreview();
}

function parseContactsCsv(text) {
  const rows = parseCsv(text);
  const skipped = [];
  if (!rows.length) return { contacts: [], skipped: [{ row: 0, reason: 'CSV is empty' }] };

  const headers = rows[0].map(normalizeHeader);
  const contacts = [];
  const seen = new Set();

  rows.slice(1).forEach((row, index) => {
    const raw = {};
    headers.forEach((header, i) => raw[header] = (row[i] || '').trim());
    const contact = normalizeContact(raw, index + 2);
    if (!contact.ok) {
      skipped.push({ row: index + 2, reason: contact.reason });
      return;
    }
    if (seen.has(contact.value.linkedin_url)) {
      skipped.push({ row: index + 2, reason: 'Duplicate LinkedIn URL' });
      return;
    }
    seen.add(contact.value.linkedin_url);
    contacts.push(contact.value);
  });

  return { contacts, skipped };
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeContact(raw, rowNumber) {
  const company = pick(raw, ['company', 'company_name', 'organization']);
  const name = pick(raw, ['founder_ceo', 'founder_and_ceo', 'founder_ceo_name', 'founder', 'ceo', 'name', 'full_name', 'person', 'person_we_are_messaging']);
  const linkedinUrl = pick(raw, ['linkedin_url', 'linkedin', 'profile_url', 'url']);
  const role = pick(raw, ['role', 'title', 'position']);

  if (!company) return { ok: false, reason: 'Missing company' };
  if (!name) return { ok: false, reason: 'Missing founder/CEO name' };
  if (!linkedinUrl || !/^https:\/\/(www\.)?linkedin\.com\/in\//i.test(linkedinUrl)) {
    return { ok: false, reason: 'Missing or invalid LinkedIn profile URL' };
  }

  return {
    ok: true,
    value: {
      id: `row-${rowNumber}-${Math.random().toString(16).slice(2)}`,
      company,
      name,
      linkedin_url: normalizeLinkedInUrl(linkedinUrl),
      role,
      rowNumber,
    },
  };
}

function pick(raw, keys) {
  for (const key of keys) {
    if (raw[key]) return raw[key];
  }
  return '';
}

function normalizeLinkedInUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = 'https:';
    parsed.hostname = 'www.linkedin.com';
    parsed.search = '';
    parsed.hash = '';
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function renderContacts() {
  if (!state.contacts.length) {
    els.contactsBody.innerHTML = '<tr><td colspan="6" class="empty">No contacts loaded.</td></tr>';
    els.queueSubtitle.textContent = 'Upload a CSV to begin.';
    return;
  }

  els.queueSubtitle.textContent = `${state.contacts.length} contact${state.contacts.length === 1 ? '' : 's'} ready.`;
  els.contactsBody.innerHTML = '';
  for (const contact of state.contacts) {
    const status = state.statuses.get(contact.id) || { kind: 'ready', text: 'Ready' };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(contact.company)}</td>
      <td>${escapeHtml(contact.name)}</td>
      <td>${escapeHtml(contact.role || '-')}</td>
      <td><a href="${escapeAttr(contact.linkedin_url)}" target="_blank" rel="noreferrer">Profile</a></td>
      <td><span class="status ${escapeAttr(status.kind)}">${escapeHtml(status.text)}</span></td>
      <td>${renderActionCell(contact, status)}</td>
    `;
    els.contactsBody.appendChild(tr);
  }
  document.querySelectorAll('.send-btn').forEach((button) => {
    button.addEventListener('click', () => sendContact(button.dataset.id));
  });
  document.querySelectorAll('.cancel-btn').forEach((button) => {
    button.addEventListener('click', () => cancelContactJob(button.dataset.id));
  });
}

function renderActionCell(contact, status) {
  if (['running', 'queued', 'canceling'].includes(status.kind)) {
    return `<button class="secondary small cancel-btn" data-id="${escapeAttr(contact.id)}">Cancel</button>`;
  }
  return `<button class="primary small send-btn" data-id="${escapeAttr(contact.id)}">Send Message</button>`;
}

function renderPreview() {
  const contact = state.contacts[0];
  els.preview.textContent = contact ? fillTemplate(els.template.value, contact) : 'Upload a CSV to preview the first contact.';
}

function fillTemplate(template, contact) {
  return template
    .replace(/\{\{name\}\}/g, firstName(contact.name))
    .replace(/\{\{full_name\}\}/g, contact.name || '')
    .replace(/\{\{company\}\}/g, contact.company || '')
    .replace(/\{\{role\}\}/g, contact.role || '');
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

async function sendContact(id) {
  const contact = state.contacts.find((c) => c.id === id);
  if (!contact) return;
  const message = fillTemplate(els.template.value, contact);
  if (!message.trim()) {
    appendLog(`Cannot send to ${contact.name}: message is empty.`);
    return;
  }

  setStatus(id, 'running', 'Queueing');
  appendLog(`Queueing send to ${contact.name} (${contact.company})...`);

  try {
    const response = await api('/api/send', {
      method: 'POST',
      body: JSON.stringify({ contact, message }),
    });
    if (!response.ok) throw new Error(response.reason || 'Send failed');
    state.activeJobs.set(response.jobId, id);
    state.contactJobs.set(id, response.jobId);
    state.primaryJobId = response.jobId;
    if (response.job) state.jobs.set(response.jobId, response.job);
    const status = response.job?.status || (response.queuePosition > 0 ? 'queued' : 'running');
    setStatus(id, status === 'queued' ? 'queued' : 'running', status === 'queued' ? `Queued #${response.queuePosition || 1}` : 'Running');
    pollJob(response.jobId, id);
  } catch (err) {
    setStatus(id, 'failed', 'Failed');
    appendLog(`Failed to start send: ${err.message}`);
  }
}

async function pollJob(jobId, contactId) {
  let lastLogCount = 0;
  while (true) {
    let job = null;
    try {
      job = await api(`/api/jobs/${jobId}`);
    } catch (err) {
      setStatus(contactId, 'failed', 'Status lost');
      appendLog(`Could not poll job status: ${err.message}`);
      await refreshSafety().catch(() => {});
      return;
    }
    state.jobs.set(jobId, job);
    if (!state.primaryJobId || ['queued', 'running', 'canceling'].includes(job.status)) state.primaryJobId = jobId;
    renderJobPanel();
    for (const entry of job.logs.slice(lastLogCount)) appendLog(entry.text);
    lastLogCount = job.logs.length;

    if (job.status === 'queued') {
      setStatus(contactId, 'queued', `Queued #${job.queuePosition || 1}`);
    } else if (job.status === 'running') {
      setStatus(contactId, 'running', 'Running');
    } else if (job.status === 'canceling') {
      setStatus(contactId, 'canceling', 'Canceling');
    }

    if (job.status === 'completed') {
      state.contactJobs.delete(contactId);
      state.activeJobs.delete(jobId);
      setStatus(contactId, 'sent', 'Sent');
      await refreshSafety();
      return;
    }
    if (job.status === 'failed') {
      state.contactJobs.delete(contactId);
      state.activeJobs.delete(jobId);
      setStatus(contactId, 'failed', 'Failed');
      appendLog(job.error || 'Send failed.');
      await refreshSafety();
      return;
    }
    if (job.status === 'canceled') {
      state.contactJobs.delete(contactId);
      state.activeJobs.delete(jobId);
      setStatus(contactId, 'canceled', 'Canceled');
      appendLog(job.error || 'Canceled.');
      await refreshSafety();
      return;
    }
    await sleep(1000);
  }
}

async function cancelContactJob(contactId) {
  const jobId = state.contactJobs.get(contactId);
  if (!jobId) return;
  setStatus(contactId, 'canceling', 'Canceling');
  appendLog('Cancel requested.');
  try {
    await api(`/api/jobs/${jobId}/cancel`, { method: 'POST', body: '{}' });
  } catch (err) {
    appendLog(`Could not cancel job: ${err.message}`);
  }
}

function setStatus(id, kind, text) {
  state.statuses.set(id, { kind, text });
  renderContacts();
}

function renderJobPanel() {
  const job = pickPrimaryJob();
  if (!job) {
    els.jobTitle.textContent = 'Idle';
    els.jobPhase.textContent = '-';
    els.jobElapsed.textContent = '-';
    els.jobLastUpdate.textContent = '-';
    els.jobQueuePosition.textContent = '-';
    els.jobGuidance.textContent = 'No active send. Queue a contact to see live progress here.';
    els.jobPanel.classList.remove('warn');
    return;
  }

  const now = Date.now();
  const start = Date.parse(job.startedAt || job.queuedAt || new Date().toISOString());
  const lastUpdate = Date.parse(job.lastUpdateAt || job.startedAt || job.queuedAt || new Date().toISOString());
  const elapsedSec = Math.max(0, Math.round((now - start) / 1000));
  const staleSec = Math.max(0, Math.round((now - lastUpdate) / 1000));
  const phase = job.phase || job.status;
  const guidance = phaseGuidance(phase, elapsedSec, staleSec, job);

  els.jobTitle.textContent = job.contact?.name ? `${job.contact.name} - ${job.contact.company || 'LinkedIn'}` : job.id;
  els.jobPhase.textContent = prettyPhase(phase);
  els.jobElapsed.textContent = formatDuration(elapsedSec);
  els.jobLastUpdate.textContent = `${formatDuration(staleSec)} ago`;
  els.jobQueuePosition.textContent = job.status === 'queued' ? `#${job.queuePosition || 1}` : (job.status === 'running' ? 'Active' : job.status);
  els.jobGuidance.textContent = guidance.text;
  els.jobPanel.classList.toggle('warn', guidance.warn);
}

function pickPrimaryJob() {
  const active = Array.from(state.jobs.values()).find((job) => ['running', 'canceling'].includes(job.status));
  if (active) return active;
  const queued = Array.from(state.jobs.values())
    .filter((job) => job.status === 'queued')
    .sort((a, b) => (a.queuePosition || 999) - (b.queuePosition || 999))[0];
  if (queued) return queued;
  if (state.primaryJobId) return state.jobs.get(state.primaryJobId) || null;
  return Array.from(state.jobs.values()).at(-1) || null;
}

function phaseGuidance(phase, elapsedSec, staleSec, job) {
  const settings = state.settings || { minDelay: 60, maxDelay: 180 };
  const delayMax = Number(settings.maxDelay || 0);
  const warningByPhase = {
    queued: 0,
    starting: 45,
    launching_browser: 60,
    needs_login: 0,
    profile_loaded: 45,
    opening_composer: 60,
    drafting: 60,
    draft_verified: 30,
    safety_delay: delayMax + 45,
    sending: 45,
    sent: 0,
    failed: 0,
    canceling: 20,
    canceled: 0,
  };
  const warnAt = warningByPhase[phase] ?? 60;
  const warn = warnAt > 0 && staleSec > warnAt;

  const textByPhase = {
    queued: `Waiting behind ${Math.max((job.queuePosition || 1) - 1, 0)} job(s).`,
    starting: 'Starting the local Playwright sender.',
    launching_browser: 'Opening the LinkedIn browser profile.',
    needs_login: 'LinkedIn needs login or checkpoint attention in the opened browser.',
    profile_loaded: 'Profile loaded; locating the Message button.',
    opening_composer: 'Clicking Message and waiting for the composer.',
    drafting: 'Composer found; typing the message.',
    draft_verified: 'Draft text was verified; preparing to send.',
    safety_delay: `Safety delay before Send is expected. Current configured range is ${settings.minDelay}-${settings.maxDelay}s.`,
    sending: 'Clicking Send and verifying the composer cleared.',
    sent: 'Message was sent and verified.',
    failed: 'The job failed. Check the activity log for the reason.',
    canceling: 'Stopping the active Playwright process.',
    canceled: 'Job was canceled.',
  };

  return {
    warn,
    text: warn
      ? `This phase has not updated for ${formatDuration(staleSec)}. It may be stuck; check the Playwright browser or cancel the job.`
      : (textByPhase[phase] || `Status: ${job.status}.`),
  };
}

function prettyPhase(phase) {
  return String(phase || '-')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

async function refreshSafety() {
  const safety = await api('/api/safety/status');
  state.safety = safety;
  state.settings = safety.settings;
  els.todayCount.textContent = `${safety.todayCount} / ${safety.dailyCap}`;
  els.activeHours.textContent = safety.activeHours;
  els.delayRange.textContent = `${safety.settings.minDelay}-${safety.settings.maxDelay}s`;
  els.failureCount.textContent = `${safety.consecutiveFailures} / 3`;
  els.queueState.textContent = safety.queue?.activeJobId
    ? `1 active, ${safety.queue.queued} waiting`
    : (safety.queue?.queued ? `${safety.queue.queued} waiting` : 'Idle');
  els.haltState.textContent = safety.halted ? 'Halted' : 'Clear';
  els.haltBox.classList.toggle('halted', !!safety.halted);
}

async function resetHalt() {
  await api('/api/safety/reset-halt', { method: 'POST', body: '{}' });
  appendLog('Safety halt reset.');
  await refreshSafety();
}

function openSettings() {
  const settings = state.settings || { dailyCap: 5, activeHours: '09:00-18:00', minDelay: 60, maxDelay: 180 };
  els.settingDailyCap.value = settings.dailyCap;
  els.settingActiveHours.value = settings.activeHours;
  els.settingMinDelay.value = settings.minDelay;
  els.settingMaxDelay.value = settings.maxDelay;
  els.settingAllowRepeat.checked = !!settings.allowRepeat;
  els.settingAllowDuplicateMessage.checked = !!settings.allowDuplicateMessage;
  els.riskAck.checked = false;
  els.settingsModal.classList.remove('hidden');
}

function closeSettings() {
  els.settingsModal.classList.add('hidden');
}

async function saveSettings() {
  if (!els.riskAck.checked) {
    appendLog('Safety settings not saved: risk acknowledgment is required.');
    return;
  }
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        dailyCap: Number(els.settingDailyCap.value),
        activeHours: els.settingActiveHours.value,
        minDelay: Number(els.settingMinDelay.value),
        maxDelay: Number(els.settingMaxDelay.value),
        allowRepeat: els.settingAllowRepeat.checked,
        allowDuplicateMessage: els.settingAllowDuplicateMessage.checked,
      }),
    });
    closeSettings();
    appendLog('Safety settings updated.');
    await refreshSafety();
  } catch (err) {
    appendLog(`Could not save settings: ${err.message}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const json = await response.json();
  if (!response.ok || (json.ok === false && Object.prototype.hasOwnProperty.call(json, 'reason'))) {
    throw new Error(json.reason || 'Request failed');
  }
  return json;
}

function appendLog(text) {
  const existing = els.log.textContent === 'Ready.' ? '' : els.log.textContent + '\n';
  els.log.textContent = existing + `[${new Date().toLocaleTimeString()}] ${text}`;
  els.log.scrollTop = els.log.scrollHeight;
}

function insertAtCursor(input, value) {
  const start = input.selectionStart || 0;
  const end = input.selectionEnd || 0;
  input.value = input.value.slice(0, start) + value + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + value.length;
  input.focus();
  renderPreview();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
