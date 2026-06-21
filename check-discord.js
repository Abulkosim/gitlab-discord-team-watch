#!/usr/bin/env node
/**
 * check-discord.js — quick standalone test of the Discord webhook.
 *
 * Reads DISCORD_WEBHOOK_URL from the .env next to this file (or the environment)
 * and posts a message to the channel. Does NOT touch gitlab-watch.js or hit GitLab.
 *
 * Zero dependencies — uses Node's built-in fetch + readline (Node 18+).
 *
 * Usage:
 *   node check-discord.js            # loops: type a message, Enter to send, repeat
 *   node check-discord.js "any text" # posts the text you pass directly, once
 *
 * In loop mode, send an empty line or press Ctrl-C / Ctrl-D to quit.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

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

const url = (process.env.DISCORD_WEBHOOK_URL || '').trim();
if (!url) {
  console.error('DISCORD_WEBHOOK_URL is not set in .env (or the environment).');
  process.exit(1);
}

async function send(message) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'gitlab-team-watch-check' },
      body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      console.log(`✅ Posted "${message}" — Discord returned HTTP ${resp.status}.`);
      return true;
    }
    const body = (await resp.text()).slice(0, 300);
    console.log(`❌ HTTP ${resp.status} from Discord: ${body}\n` +
      `   (Check the webhook URL is correct and not deleted.)`);
  } catch (e) {
    console.log(`❌ Could not reach Discord: ${e.message}`);
  }
  return false;
}

async function main() {
  // One-shot mode: a message was passed as an argument.
  if (process.argv.length > 2) {
    const ok = await send(process.argv.slice(2).join(' '));
    process.exit(ok ? 0 : 1);
  }

  // Loop mode: keep prompting until empty line / Ctrl-C / Ctrl-D.
  console.log('Type a message and press Enter to send. Empty line or Ctrl-C to quit.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();

  // Queue lines and process strictly in order with a single worker. This keeps
  // message order and avoids races when many lines arrive at once (e.g. piped input).
  const queue = [];
  let working = false;
  let streamClosed = false;
  const finish = () => { console.log('Bye.'); process.exit(0); };

  async function drain() {
    if (working) return;
    working = true;
    while (queue.length) {
      const answer = queue.shift().trim();
      if (!answer) return finish();   // empty line = quit
      await send(answer);
      rl.prompt();
    }
    working = false;
    if (streamClosed) finish();       // input ended (Ctrl-D / EOF) after draining
  }

  rl.on('line', (line) => { queue.push(line); drain(); });
  rl.on('close', () => { streamClosed = true; if (!working) finish(); });
}

main();
