const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, '.linkedin-outreach-data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const LEDGER_PATH = path.join(DATA_DIR, 'ledger.json');
const RESULTS_CSV_PATH = path.join(DATA_DIR, 'results.csv');
const PORT = Number(process.env.PORT || 3000);

const DEFAULT_SETTINGS = {
  dailyCap: 5,
  activeHours: '09:00-18:00',
  minDelay: 60,
  maxDelay: 180,
  allowRepeat: false,
  allowDuplicateMessage: false,
};

const jobs = new Map();
const sendQueue = [];
let activeJobId = null;

ensureDataDir();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/safety/status') {
      return sendJson(res, getSafetyStatus());
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(res, loadSettings());
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJson(req);
      const settings = saveSettings(body);
      return sendJson(res, settings);
    }

    if (req.method === 'POST' && url.pathname === '/api/safety/reset-halt') {
      const ledger = loadLedger();
      ledger.halted = null;
      ledger.consecutiveFailures = 0;
      saveLedger(ledger);
      return sendJson(res, getSafetyStatus());
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = await readJson(req);
      const job = enqueueSendJob(body);
      return sendJson(res, { ok: true, jobId: job.id, queuePosition: job.queuePosition, job: publicJob(job) });
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 20), 100));
      return sendJson(res, {
        ok: true,
        jobs: Array.from(jobs.values()).slice(-limit).map(publicJob),
      });
    }

    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const job = cancelJob(cancelMatch[1]);
      return sendJson(res, { ok: true, job: publicJob(job) });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, { ok: false, reason: 'Job not found' }, 404);
      return sendJson(res, publicJob(job));
    }

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[server] error:', err);
    return sendJson(res, { ok: false, reason: err.message || String(err) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`[server] LinkedIn Outreach UI running at http://localhost:${PORT}`);
});

function enqueueSendJob({ contact, message }) {
  if (!contact?.linkedin_url) throw new Error('Missing contact.linkedin_url');
  if (!/^https:\/\/(www\.)?linkedin\.com\/in\//i.test(contact.linkedin_url)) {
    throw new Error('Expected a direct LinkedIn profile URL like https://www.linkedin.com/in/<handle>/');
  }
  if (!message?.trim()) throw new Error('Missing message');

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    ok: null,
    status: 'queued',
    contact,
    message,
    queuePosition: sendQueue.length + 1,
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    error: null,
    child: null,
    cancelRequested: false,
    phase: 'queued',
    lastUpdateAt: new Date().toISOString(),
    lastLog: '',
  };
  jobs.set(id, job);
  sendQueue.push(id);
  addLog(job, `Queued send for ${contact.name || contact.linkedin_url}`);
  refreshQueuePositions();
  processSendQueue();
  return job;
}

function processSendQueue() {
  if (activeJobId) return;
  const nextId = sendQueue.shift();
  if (!nextId) return;
  refreshQueuePositions();

  const job = jobs.get(nextId);
  if (!job) {
    processSendQueue();
    return;
  }

  activeJobId = job.id;
  startSendJob(job);
}

function startSendJob(job) {
  const { contact, message } = job;
  const settings = loadSettings();

  job.status = 'running';
  job.phase = 'starting';
  job.queuePosition = 0;
  job.startedAt = new Date().toISOString();
  job.lastUpdateAt = job.startedAt;

  const args = [
    path.join(ROOT, 'scripts/playwright-draft.js'),
    '--send',
    '--close',
    '--url', contact.linkedin_url,
    '--message', message,
    '--daily-cap', String(settings.dailyCap),
    '--active-hours', settings.activeHours,
    '--min-delay', String(settings.minDelay),
    '--max-delay', String(settings.maxDelay),
  ];
  if (settings.allowRepeat) args.push('--allow-repeat');
  if (settings.allowDuplicateMessage) args.push('--allow-duplicate-message');

  addLog(job, `Starting send for ${contact.name || contact.linkedin_url}`);
  addLog(job, `Queue is locked to one active send. Playwright will wait ${settings.minDelay}-${settings.maxDelay}s before clicking Send.`);
  if (settings.allowRepeat) addLog(job, 'Repeat-profile safety override is enabled for this send.');
  if (settings.allowDuplicateMessage) addLog(job, 'Duplicate-message safety override is enabled for this send.');
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
  });
  job.child = child;
  let finished = false;

  child.stdout.on('data', (chunk) => addLog(job, chunk.toString()));
  child.stderr.on('data', (chunk) => addLog(job, chunk.toString()));
  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    job.status = 'failed';
    job.phase = 'failed';
    job.ok = false;
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    job.child = null;
    addLog(job, `Process error: ${err.message}`);
    if (activeJobId === job.id) activeJobId = null;
    processSendQueue();
  });
  child.on('close', (code) => {
    if (finished) return;
    finished = true;
    if (job.cancelRequested) {
      job.status = 'canceled';
      job.phase = 'canceled';
      job.ok = false;
      job.error = 'Canceled by user';
    } else {
      job.status = code === 0 ? 'completed' : 'failed';
      job.ok = code === 0;
      if (code === 0) {
        job.phase = 'sent';
      } else {
        job.phase = job.phase === 'needs_login' ? 'needs_login' : 'failed';
        job.error = job.lastLog || `Sender exited with code ${code}`;
      }
    }
    job.finishedAt = new Date().toISOString();
    job.child = null;
    addLog(job, `Sender exited with code ${code}`);
    if (activeJobId === job.id) activeJobId = null;
    processSendQueue();
  });

  return job;
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    ok: job.ok,
    status: job.status,
    contact: job.contact,
    queuePosition: job.queuePosition,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    logs: job.logs,
    error: job.error,
    cancelRequested: job.cancelRequested,
    phase: job.phase,
    lastUpdateAt: job.lastUpdateAt,
    lastLog: job.lastLog,
  };
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error('Job not found');

    if (job.status === 'queued') {
    const index = sendQueue.indexOf(id);
    if (index !== -1) sendQueue.splice(index, 1);
    job.status = 'canceled';
    job.phase = 'canceled';
    job.ok = false;
    job.error = 'Canceled before start';
    job.finishedAt = new Date().toISOString();
    addLog(job, 'Canceled before start');
    refreshQueuePositions();
    return job;
  }

  if (job.status === 'running') {
    job.cancelRequested = true;
    job.status = 'canceling';
    job.phase = 'canceling';
    addLog(job, 'Cancel requested; stopping active Playwright process');
    if (job.child && !job.child.killed) {
      job.child.kill('SIGTERM');
      setTimeout(() => {
        if (job.child && !job.child.killed) job.child.kill('SIGKILL');
      }, 5000);
    }
    return job;
  }

  return job;
}

function refreshQueuePositions() {
  sendQueue.forEach((id, index) => {
    const job = jobs.get(id);
    if (job) job.queuePosition = index + 1;
  });
}

function addLog(job, text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const at = new Date().toISOString();
    job.logs.push({ at, text: line });
    job.lastUpdateAt = at;
    job.lastLog = line;
    job.phase = inferPhase(job.phase, line);
  }
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
}

function inferPhase(current, line) {
  const text = line.toLowerCase();
  if (text.includes('queued send')) return 'queued';
  if (text.includes('starting send')) return 'starting';
  if (text.includes('launching browser')) return 'launching_browser';
  if (text.includes('linkedin wants login') || text.includes('checkpoint')) return 'needs_login';
  if (text.includes('profile owner')) return 'profile_loaded';
  if (text.includes('clicking message')) return 'opening_composer';
  if (text.includes('composer found')) return 'drafting';
  if (text.includes('draft inserted and verified')) return 'draft_verified';
  if (text.includes('safety delay before send')) return 'safety_delay';
  if (text.includes('sending message')) return 'sending';
  if (text.includes('message sent and verified')) return 'sent';
  if (text.includes('fatal') || text.includes('failed') || text.includes('error')) return 'failed';
  if (text.includes('cancel')) return 'canceling';
  return current;
}

function getSafetyStatus() {
  const settings = loadSettings();
  const ledger = loadLedger();
  const today = localDateKey(new Date());
  const profilesToday = new Set(
    ledger.sends
      .filter((entry) => entry.localDate === today)
      .map((entry) => entry.profileUrl)
  );
  return {
    settings,
    todayCount: profilesToday.size,
    dailyCap: settings.dailyCap,
    remainingToday: Math.max(settings.dailyCap - profilesToday.size, 0),
    activeHours: settings.activeHours,
    consecutiveFailures: ledger.consecutiveFailures || 0,
    halted: ledger.halted || null,
    totalSentProfiles: new Set(ledger.sends.map((entry) => entry.profileUrl)).size,
    queue: {
      activeJobId,
      queued: sendQueue.length,
    },
    ledgerPath: LEDGER_PATH,
    resultsPath: RESULTS_CSV_PATH,
  };
}

function loadSettings() {
  ensureDataDir();
  if (!fs.existsSync(SETTINGS_PATH)) {
    saveSettings(DEFAULT_SETTINGS);
  }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(input) {
  const settings = {
    dailyCap: clampInt(input.dailyCap, 1, 10, DEFAULT_SETTINGS.dailyCap),
    activeHours: validateActiveHours(input.activeHours || DEFAULT_SETTINGS.activeHours),
    minDelay: clampInt(input.minDelay, 0, 3600, DEFAULT_SETTINGS.minDelay),
    maxDelay: clampInt(input.maxDelay, 0, 3600, DEFAULT_SETTINGS.maxDelay),
    allowRepeat: input.allowRepeat === true,
    allowDuplicateMessage: input.allowDuplicateMessage === true,
  };
  if (settings.maxDelay < settings.minDelay) {
    throw new Error('Max delay must be greater than or equal to min delay.');
  }
  ensureDataDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return settings;
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
  } catch (_) {
    return { version: 1, sends: [], failures: [], consecutiveFailures: 0, halted: null };
  }
}

function saveLedger(ledger) {
  ensureDataDir();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validateActiveHours(value) {
  const s = String(value || '').trim();
  if (!/^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/.test(s)) {
    throw new Error('Active hours must be formatted like 09:00-18:00.');
  }
  return s;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': contentType(filePath) });
    res.end(data);
  });
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
