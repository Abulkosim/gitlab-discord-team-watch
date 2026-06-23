#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
};
const color = (s, ...codes) => codes.map((c) => C[c]).join('') + s + C.reset;

function loadDotenv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotenv();

const BASE = (process.env.GITLAB_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.GITLAB_TOKEN || '';
const GROUP = (process.env.GITLAB_GROUP || '').trim();
const USERS = (process.env.GITLAB_USERS || '').split(',').map((u) => u.trim()).filter(Boolean);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30', 10);
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();

function fail(msg) {
  process.stderr.write(color(`Error: `, 'bold', 'red') + msg + '\n');
  process.exit(1);
}

if (!BASE) fail('GITLAB_URL is not set. See the README / .env.example.');
if (!TOKEN) fail('GITLAB_TOKEN is not set. Create a personal access token with `read_api` scope.');
if (!GROUP && USERS.length === 0) {
  fail('Set GITLAB_GROUP and/or GITLAB_USERS so the tool knows whom to watch.');
}
if (!DISCORD_WEBHOOK_URL) {
  fail('DISCORD_WEBHOOK_URL is not set. This tool posts team activity to Discord — set the webhook URL. See README.');
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function apiGet(p, params) {
  let url = `${BASE}/api/v4${p}`;
  if (params) url += '?' + new URLSearchParams(params).toString();
  let resp;
  try {
    resp = await fetch(url, {
      headers: { 'PRIVATE-TOKEN': TOKEN, 'User-Agent': 'gitlab-team-watch' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw new Error(`Cannot reach ${BASE} — are you on the office network/VPN? (${e.message})`);
  }
  if (!resp.ok) {
    if (resp.status === 401) fail('401 Unauthorized — check GITLAB_TOKEN (needs `read_api` scope).');
    const body = (await resp.text()).slice(0, 200);
    throw new HttpError(resp.status, body);
  }
  return resp.json();
}

async function resolveMembers() {
  const members = new Map();

  if (GROUP) {
    const gid = /^\d+$/.test(GROUP) ? GROUP : encodeURIComponent(GROUP);
    let page = 1;
    for (;;) {
      let batch;
      try {
        batch = await apiGet(`/groups/${gid}/members/all`, { per_page: '100', page: String(page) });
      } catch (e) {
        if (e instanceof HttpError) fail(`Group '${GROUP}' not found or not accessible with this token.`);
        throw e;
      }
      if (!batch.length) break;
      for (const m of batch) members.set(m.id, { id: m.id, name: m.name, username: m.username });
      if (batch.length < 100) break;
      page += 1;
    }
  }

  for (const username of USERS) {
    const found = await apiGet('/users', { username });
    if (found.length) {
      const u = found[0];
      members.set(u.id, { id: u.id, name: u.name, username: u.username });
    } else {
      process.stderr.write(color('Warning: ', 'yellow') + `user '${username}' not found, skipping.\n`);
    }
  }

  if (members.size === 0) fail('No members resolved. Check GITLAB_GROUP / GITLAB_USERS.');
  return [...members.values()];
}

async function fetchUserEvents(user, perPage = 30) {
  let events;
  try {
    events = await apiGet(`/users/${user.id}/events`, { per_page: String(perPage), sort: 'desc' });
  } catch (e) {
    if (e instanceof HttpError) return [];
    throw e;
  }
  for (const e of events) e._user = user;
  return events;
}

const TARGET_LABEL = {
  MergeRequest: 'MR', Issue: 'issue', Note: 'comment', DiffNote: 'comment',
  Milestone: 'milestone', 'WikiPage::Meta': 'wiki',
};

function describe(event) {
  const action = event.action_name || 'did';
  const targetType = event.target_type || '';
  const title = event.target_title || '';
  const iid = event.target_iid;

  const push = event.push_data;
  if (push) {
    const count = push.commit_count || 0;
    const ref = push.ref || '';
    const plural = count === 1 ? 'commit' : 'commits';
    const ct = push.commit_title || '';
    const base = `pushed ${count} ${plural} to ${ref}`;
    return ct ? `${base} — ${ct}` : base;
  }

  const label = TARGET_LABEL[targetType] ?? targetType.toLowerCase();
  let ref = '';
  if (targetType === 'MergeRequest' && iid) ref = ` !${iid}`;
  else if (targetType === 'Issue' && iid) ref = ` #${iid}`;

  const parts = [action];
  if (label) parts.push(label + ref);
  let desc = parts.join(' ').trim();
  if (title && label !== 'comment') desc += `: ${title}`;
  return desc;
}

const projectCache = new Map();
async function projectName(event) {
  const pid = event.project_id;
  if (pid == null) return '';
  if (!projectCache.has(pid)) {
    try {
      const proj = await apiGet(`/projects/${pid}`);
      projectCache.set(pid, proj.path_with_namespace || String(pid));
    } catch {
      projectCache.set(pid, String(pid));
    }
  }
  return projectCache.get(pid);
}

function clockTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '--:--:--';
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
}

async function discordLine(event) {
  const author = (event.author && event.author.name) || event._user.name;
  const proj = await projectName(event);
  const time = clockTime(event.created_at || '');
  const projPart = proj ? ` · \`${proj}\`` : '';
  return `\`${time}\`  **${author}**  ${describe(event)}${projPart}`;
}

async function postToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'gitlab-team-watch' },
      body: JSON.stringify({ content: content.slice(0, 1990), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
  }
}

async function notifyDiscord(newEvents) {
  if (!DISCORD_WEBHOOK_URL || newEvents.length === 0) return;

  const ordered = [...newEvents].reverse();
  const lines = [];
  for (const e of ordered) lines.push(await discordLine(e));

  const n = ordered.length;
  const title = `**${n} new event${n === 1 ? '' : 's'}**`;

  let first = true;
  let chunk = [], size = title.length + 1;
  for (const line of lines) {
    if (size + line.length + 1 > 1900 && chunk.length) {
      await postToDiscord((first ? title + '\n' : '') + chunk.join('\n'));
      first = false; chunk = []; size = 0;
    }
    chunk.push(line);
    size += line.length + 1;
  }
  if (chunk.length) await postToDiscord((first ? title + '\n' : '') + chunk.join('\n'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FETCH_CONCURRENCY = Math.max(1, parseInt(process.env.FETCH_CONCURRENCY || '8', 10));

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function stamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}
function log(msg) {
  process.stdout.write(color(`[${stamp()}] `, 'dim') + msg + '\n');
}
function warn(msg) {
  process.stderr.write(color(`[${stamp()}] `, 'dim') + color('warn ', 'yellow') + msg + '\n');
}

async function main() {
  const watching = [
    GROUP ? `group ${GROUP}` : '',
    GROUP && USERS.length ? ' + ' : '',
    USERS.length ? `users ${USERS.join(',')}` : '',
  ].join('');
  log(color(`Resolving team members from ${watching} …`, 'dim'));

  const members = await resolveMembers();
  log(color(`Watching ${members.length} member(s) on ${BASE}.`, 'green') +
    ` Polling every ${POLL_INTERVAL}s, posting to Discord. Ctrl-C to quit.`);

  // Remember which events we've already handled so we don't re-notify. Bounded
  // so a long-running daemon doesn't grow this set forever; old ids fall out of
  // GitLab's recent-events window long before they're evicted, so they can't
  // resurface as "new".
  const seen = new Set();
  const seenOrder = [];
  const SEEN_CAP = Math.max(2000, members.length * 200);
  function markSeen(id) {
    if (seen.has(id)) return;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_CAP) seen.delete(seenOrder.shift());
  }

  let firstPoll = true;

  async function poll() {
    const perUser = await mapPool(members, FETCH_CONCURRENCY, (m) => fetchUserEvents(m));
    const byId = new Map();
    for (const e of perUser.flat()) {
      if (e.id != null) byId.set(e.id, e);
    }
    const fresh = [...byId.values()].filter((e) => !seen.has(e.id));
    for (const e of fresh) markSeen(e.id);
    fresh.sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return fresh;
  }

  process.on('SIGINT', () => { log(color('Stopped.', 'dim')); process.exit(0); });

  for (;;) {
    try {
      const fresh = await poll();
      if (firstPoll) {
        log(color(`Primed feed with ${fresh.length} recent event(s) — no notifications sent.`, 'cyan'));
      } else if (fresh.length) {
        await notifyDiscord(fresh);
        log(`${fresh.length} new event(s) posted to Discord.`);
      } else {
        log(color('No new events.', 'dim'));
      }
      firstPoll = false;
    } catch (err) {
      warn(`${err.message} — retrying in ${POLL_INTERVAL}s`);
    }
    await sleep(POLL_INTERVAL * 1000);
  }
}

main().catch((e) => fail(e.message));
