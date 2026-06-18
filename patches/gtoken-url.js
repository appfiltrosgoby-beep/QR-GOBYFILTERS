/**
 * Patch: gtoken URL update
 *
 * gtoken v7.1.0 uses the deprecated endpoint https://www.googleapis.com/oauth2/v4/token
 * which causes ERR_STREAM_PREMATURE_CLOSE on Render's free tier.
 * Replace with the current canonical endpoint.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OLD_URL = 'https://www.googleapis.com/oauth2/v4/token';
const NEW_URL = 'https://oauth2.googleapis.com/token';
const TARGET = path.join(__dirname, '..', 'node_modules', 'gtoken', 'build', 'src', 'index.js');

if (!fs.existsSync(TARGET)) {
  console.log('patches/gtoken-url.js: gtoken not found, skipping.');
  process.exit(0);
}

const original = fs.readFileSync(TARGET, 'utf8');

if (!original.includes(OLD_URL)) {
  console.log('patches/gtoken-url.js: URL already up-to-date, nothing to do.');
  process.exit(0);
}

const patched = original.split(OLD_URL).join(NEW_URL);
fs.writeFileSync(TARGET, patched, 'utf8');

const count = (original.match(new RegExp(OLD_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
console.log(`patches/gtoken-url.js: patched ${count} occurrence(s) → ${NEW_URL}`);
