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
const EVENT_LIMIT = parseInt(process.env.EVENT_LIMIT || '40', 10);
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

const ACTION_COLOR = {
  'pushed to': 'cyan', 'pushed new': 'cyan', deleted: 'red',
  opened: 'green', closed: 'yellow', merged: 'magenta', accepted: 'magenta',
  'commented on': 'blue', joined: 'dim', left: 'dim', created: 'green',
};

const TARGET_LABEL = {
  MergeRequest: 'MR', Issue: 'issue', Note: 'comment', DiffNote: 'comment',
  Milestone: 'milestone', 'WikiPage::Meta': 'wiki',
};

function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '?';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

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

function fit(s, width, align = 'left') {
  s = String(s ?? '');
  if (s.length > width) s = width > 1 ? s.slice(0, width - 1) + '…' : s.slice(0, width);
  return align === 'right' ? s.padStart(width) : s.padEnd(width);
}

async function buildRows(events, newIds) {
  const cols = process.stdout.columns || 100;
  const wMark = 2, wWho = 16, wWhen = 6, wProj = Math.min(24, Math.max(10, Math.floor(cols * 0.2)));
  const wAction = Math.max(20, cols - wMark - wWho - wProj - wWhen - 4);

  const lines = [];
  for (const e of events.slice(0, EVENT_LIMIT)) {
    const author = (e.author && e.author.name) || e._user.name;
    const action = e.action_name || '';
    const col = ACTION_COLOR[action] || 'white';
    const isNew = newIds.has(e.id);

    const mark = isNew ? color('*', 'bold', 'green') : ' '.repeat(wMark);
    const who = color(fit(author, wWho), 'bold');
    const act = color(fit(describe(e), wAction), col);
    const proj = color(fit(await projectName(e), wProj), 'dim');
    const when = color(fit(relTime(e.created_at || ''), wWhen, 'right'), 'dim');
    lines.push(`${fit(mark, wMark)} ${who} ${act} ${proj} ${when}`);
  }
  return lines;
}

const CLEAR = '\x1b[2J\x1b[H';

async function render(events, newIds, status, memberCount) {
  const rows = await buildRows(events, newIds);
  const title = color(' GitLab Team Activity ', 'bold', 'cyan');
  const sub = color(`${memberCount} members · ${BASE}`, 'dim');
  let out = CLEAR;
  out += title + '\n';
  out += color(status, 'dim') + '\n\n';
  out += rows.join('\n') + '\n\n';
  out += sub + '\n';
  process.stdout.write(out);
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

async function main() {
  const watching = [
    GROUP ? `group ${GROUP}` : '',
    GROUP && USERS.length ? ' + ' : '',
    USERS.length ? `users ${USERS.join(',')}` : '',
  ].join('');
  process.stdout.write(color(`Resolving team members from ${watching} …\n`, 'dim'));

  const members = await resolveMembers();
  process.stdout.write(color(`Watching ${members.length} member(s).`, 'green') +
    ` Polling every ${POLL_INTERVAL}s. Ctrl-C to quit.\n`);
  if (DISCORD_WEBHOOK_URL) {
    process.stdout.write(color('Discord notifications enabled', 'cyan') +
      ' (first poll primes the feed; pings start with the next new event).\n');
  }

  const seen = new Set();
  let feed = [];
  let firstPoll = true;

  async function poll() {
    let collected = [];
    for (const m of members) collected = collected.concat(await fetchUserEvents(m));
    const byId = new Map();
    for (const e of [...collected, ...feed]) {
      if (e.id != null) byId.set(e.id, e);
    }
    const merged = [...byId.values()].sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const newIds = new Set(merged.filter((e) => !seen.has(e.id)).map((e) => e.id));
    for (const id of newIds) seen.add(id);
    feed = merged.slice(0, Math.max(EVENT_LIMIT * 3, 120));
    return newIds;
  }

  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.on('SIGINT', () => { restore(); process.stdout.write(color('Stopped.\n', 'dim')); process.exit(0); });

  for (;;) {
    const stamp = new Date().toLocaleTimeString();
    await render(feed, new Set(), `Refreshing… (last attempt ${stamp})`, members.length);
    let newIds, status;
    try {
      newIds = await poll();
      if (!firstPoll) await notifyDiscord(feed.filter((e) => newIds.has(e.id)));
      firstPoll = false;
      status = `Updated ${new Date().toLocaleTimeString()} · ${newIds.size} new since last poll · next in ${POLL_INTERVAL}s`;
    } catch (err) {
      newIds = new Set();
      status = `${err.message} · retrying in ${POLL_INTERVAL}s`;
    }
    await render(feed, newIds, status, members.length);
    await sleep(POLL_INTERVAL * 1000);
  }
}

main().catch((e) => { process.stdout.write('\x1b[?25h\x1b[?1049l'); fail(e.message); });
