import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { URL } from 'url';
import { chromium } from 'playwright';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBk3RyolpOBCEmGR9iqqvphkl8r-JNtDFY',
  authDomain: 'bcbrooklyn-data.firebaseapp.com',
  projectId: 'bcbrooklyn-data',
  storageBucket: 'bcbrooklyn-data.firebasestorage.app',
  messagingSenderId: '420950247250',
  appId: '1:420950247250:web:42259d89031803474f9c8b'
};

const DEFAULT_LIST_URL = 'https://www.clubs.brooklyn.cuny.edu/club_signup?view=all&';
const DEFAULT_LOGIN_URL = 'https://www.clubs.brooklyn.cuny.edu/webapp/auth/login?redirect=%2Fclub_signup%3Fview%3Dall%26';
const AUTH_STATE_PATH = path.resolve('.auth', 'webcentral-storage-state.json');
const ARTIFACTS_DIR = path.resolve('artifacts');
const PAGE_SIZE = 300;
const REQUEST_TIMEOUT_MS = Number(getArgValue('--timeout-ms')) || 45000;
const ICON_SIZE_PX = 160;

const username = process.env.BC_WEBCENTRAL_USERNAME || '';
const password = process.env.BC_WEBCENTRAL_PASSWORD || '';
const authToken = process.env.FIREBASE_AUTH_TOKEN || '';
const listUrl = process.env.BC_CLUB_SIGNUP_URL || DEFAULT_LIST_URL;
const loginUrl = process.env.BC_LOGIN_URL || DEFAULT_LOGIN_URL;
const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const headed = process.argv.includes('--headed');

function getArgValue(name) {
  const arg = process.argv.find(value => value === name || value.startsWith(name + '='));
  if (!arg) return '';
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  const idx = process.argv.indexOf(arg);
  return process.argv[idx + 1] || '';
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return normalize(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#038;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function absoluteUrl(rawUrl, baseUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl, baseUrl).href;
  } catch (_) {
    return rawUrl;
  }
}

function isDefaultLogo(url) {
  return /listing-default|default(?:_|-)?(?:image|logo)|placeholder|no(?:_|-)?image/i.test(url || '');
}

function canonicalName(value) {
  return decodeEntities(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(the|club|student|students|association|organization|society|inc)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function lookupAliases(value) {
  const text = decodeEntities(value);
  const aliases = new Set([canonicalName(text)]);
  for (const match of text.matchAll(/\(([^)]+)\)/g)) {
    const alias = canonicalName(match[1]);
    if (alias) aliases.add(alias);
  }
  const acronym = canonicalName(text).split(/\s+/).filter(Boolean).map(word => word[0]).join('');
  if (acronym.length >= 2) aliases.add(acronym);
  return [...aliases].filter(Boolean);
}

function campusGroupsIdFromData(data) {
  const direct = normalize(data?.campusGroupsClubId || data?.sourceId || data?.campusGroupsId);
  if (direct) return direct;
  const sourceUrl = normalize(data?.sourceUrl || data?.website || data?.['org-website']);
  const match = sourceUrl.match(/[?&]club_id=([^&#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function firestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === 'object') return { mapValue: { fields: firestoreFields(value) } };
  return { stringValue: String(value) };
}

function firestoreFields(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, firestoreValue(value)]));
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return value;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) {
    const asNumber = Number(value.integerValue);
    return Number.isSafeInteger(asNumber) ? asNumber : value.integerValue;
  }
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in value) return decodeFirestoreFields(value.mapValue.fields || {});
  return value;
}

function decodeFirestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = Object.assign({}, options.headers || {});
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    const req = https.request(target, { method: options.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ body, headers: res.headers, statusCode: res.statusCode });
          return;
        }
        reject(new Error(`HTTP ${res.statusCode} for ${url}\n${body.toString('utf8').slice(0, 800)}`));
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function requestJson(url, options = {}) {
  const { body } = await requestBuffer(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) }
  });
  return JSON.parse(body.toString('utf8'));
}

function firestoreCollectionUrl(collectionName, pageToken = '') {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${collectionName}`);
  url.searchParams.set('key', FIREBASE_CONFIG.apiKey);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

function firestoreDocumentUrl(collectionName, docId, updateMask = []) {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${collectionName}/${encodeURIComponent(docId)}`);
  url.searchParams.set('key', FIREBASE_CONFIG.apiKey);
  for (const fieldPath of updateMask) url.searchParams.append('updateMask.fieldPaths', fieldPath);
  return url.toString();
}

function storageUploadUrl(storagePath) {
  const url = new URL(`https://firebasestorage.googleapis.com/v0/b/${FIREBASE_CONFIG.storageBucket}/o`);
  url.searchParams.set('uploadType', 'media');
  url.searchParams.set('name', storagePath);
  return url.toString();
}

function storagePublicUrl(storagePath, token) {
  const url = new URL(`https://firebasestorage.googleapis.com/v0/b/${FIREBASE_CONFIG.storageBucket}/o/${encodeURIComponent(storagePath)}`);
  url.searchParams.set('alt', 'media');
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function docIdFromName(name) {
  return String(name || '').split('/').pop();
}

async function fetchCollection(collectionName) {
  const docs = [];
  let pageToken = '';
  do {
    const page = await requestJson(firestoreCollectionUrl(collectionName, pageToken));
    docs.push(...(page.documents || []).map(doc => ({
      id: docIdFromName(doc.name),
      data: decodeFirestoreFields(doc.fields || {})
    })));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return docs;
}

function buildClubLookup(clubDocs) {
  const lookup = new Map();
  for (const doc of clubDocs) {
    const data = { ...(doc.data || {}), _docId: doc.id };
    const campusGroupsId = campusGroupsIdFromData(data);
    const names = [
      doc.id,
      data.name,
      data.clubId,
      campusGroupsId,
      data.title,
      data.groupName
    ];
    for (const name of names) {
      for (const key of lookupAliases(name)) {
        if (!lookup.has(key)) lookup.set(key, { id: doc.id, data });
      }
    }
  }
  return lookup;
}

function findExistingClub(club, lookup) {
  return lookup.get(canonicalName(club.campusGroupsClubId)) ||
    lookupAliases(club.name).map(key => lookup.get(key)).find(Boolean);
}

async function fetchPublicClubList(browser) {
  const page = await browser.newPage();
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const clubs = await page.evaluate(sourceListUrl => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('.row[role="group"][aria-label]'));
    return rows.map(row => {
      const name = clean(row.querySelector('h2.media-heading a')?.textContent || row.getAttribute('aria-label') || '');
      const input = row.querySelector('input[name="clubs"][value]');
      const campusGroupsClubId = clean(input?.getAttribute('value') || '');
      const categoryText = clean(row.querySelector('.grey-element')?.textContent || '');
      const isDepartment = /\bdepartment\b/i.test(categoryText);
      const badges = Array.from(row.querySelectorAll('.badge')).map(el => clean(el.textContent));
      const rowText = clean(row.textContent || '');
      const groupNotRegistered = badges.some(text => /group not registered yet/i.test(text)) || /group not registered yet/i.test(rowText);
      const pendingApproval = badges.some(text => /pending approval/i.test(text)) || /pending approval/i.test(rowText);
      const active = !groupNotRegistered;
      const flag = active ? 'active' : 'inactive';
      const img = row.querySelector('.media-left img');
      const logoUrl = img ? new URL(img.getAttribute('src') || img.src, sourceListUrl).href : '';
      const sourceUrl = campusGroupsClubId
        ? `https://www.clubs.brooklyn.cuny.edu/student_community?a=1&club_id=${encodeURIComponent(campusGroupsClubId)}`
        : (row.querySelector('h2.media-heading a') ? new URL(row.querySelector('h2.media-heading a').getAttribute('href'), sourceListUrl).href : sourceListUrl);
      const missionNode = campusGroupsClubId ? row.querySelector(`#club_${CSS.escape(campusGroupsClubId)}`) : null;
      let mission = '';
      if (missionNode) {
        const clone = missionNode.cloneNode(true);
        clone.querySelector('strong')?.remove();
        mission = clean(clone.textContent || '');
      }
      return {
        name,
        campusGroupsClubId,
        category: categoryText,
        isDepartment,
        groupNotRegistered,
        pendingApproval,
        active,
        flag,
        mission,
        listLogoUrl: logoUrl,
        sourceUrl
      };
    }).filter(club => club.name && club.campusGroupsClubId);
  }, listUrl);
  await page.close();
  return clubs.map(club => ({ ...club, mission: decodeEntities(club.mission), category: decodeEntities(club.category), name: decodeEntities(club.name) }));
}

async function isLoggedInClubPage(page) {
  return page.evaluate(() => Boolean(
    document.querySelector('img.club-logo') ||
    document.querySelector('.social-links') ||
    document.body?.innerText?.match(/Connect on social|About/i)
  )).catch(() => false);
}

async function visibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function fillAndSignal(locator, value) {
  const canFill = await locator.evaluate(el => {
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }).catch(() => false);
  if (!canFill) return false;
  await locator.fill(value);
  await locator.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
  return true;
}

async function clickOptionalLoginLink(page) {
  const locator = await visibleLocator(page, [
    'a[href*="/cas/brooklyn"]',
    'a:has-text("BC WebCentral Login")',
    'a[href*="/cas/login"]',
    'a[href*="login.brooklyn.cuny.edu"]',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'a:has-text("Login")',
    'a:has-text("Log in")',
    'input[type="submit"]'
  ]);
  if (!locator) return false;
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
    locator.click()
  ]);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  return true;
}

async function writeLoginDebug(page, reason) {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  const debug = await page.evaluate(message => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    return {
      reason: message,
      url: window.location.href,
      title: document.title,
      alerts: Array.from(document.querySelectorAll('.alert,.error,.errors,.message,#msg,[role="alert"]'))
        .map(el => clean(el.textContent).slice(0, 300))
        .filter(Boolean),
      bodyText: clean(document.body?.innerText || '').slice(0, 1000)
    };
  }, reason);
  const outputPath = path.join(ARTIFACTS_DIR, 'club-login-debug.json');
  await fs.writeFile(outputPath, JSON.stringify(debug, null, 2) + '\n', 'utf8');
  console.log(`Wrote sanitized login debug to ${outputPath}`);
}

async function loginIfNeeded(page, returnUrl) {
  if (await isLoggedInClubPage(page)) return;
  if (!username || !password) throw new Error('Set BC_WEBCENTRAL_USERNAME and BC_WEBCENTRAL_PASSWORD before running.');

  if (!/\/cas\/login|\/webapp\/auth\/login|login/i.test(page.url())) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const title = await page.title().catch(() => page.url());
    console.log(`Login attempt ${attempt}: ${title} (${page.url()})`);
    const passwordInput = await visibleLocator(page, [
      '#password',
      '[name="password"]',
      'input[type="password"]',
      'input[name*="pass" i]',
      'input[id*="pass" i]'
    ]);
    const usernameInput = await visibleLocator(page, [
      '#username',
      '[name="username"]',
      'input[type="email"]',
      'input[name="user"]',
      'input[name="j_username"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
      'input[name*="empl" i]',
      'input[id*="empl" i]',
      'input[type="text"]'
    ]);

    if (!usernameInput && !passwordInput) {
      if (await isLoggedInClubPage(page)) return;
      if (!(await clickOptionalLoginLink(page))) await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      continue;
    }

    const filledUsername = usernameInput ? await fillAndSignal(usernameInput, username) : false;
    const filledPassword = passwordInput ? await fillAndSignal(passwordInput, password) : false;
    if (!filledUsername && !filledPassword) {
      if (!(await clickOptionalLoginLink(page))) await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      continue;
    }

    const submit = await visibleLocator(page, [
      '#submit',
      'button[name="submit"]',
      'input[name="submit"]',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
      'input[value*="Log" i]',
      'input[value*="Sign" i]',
      'input[value*="Continue" i]'
    ]);

    if (submit) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        submit.click()
      ]);
    } else if (passwordInput) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        passwordInput.press('Enter')
      ]);
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (/\/cas\/brooklyn|\/webapp\/auth\/login/i.test(page.url())) {
      await page.waitForURL(/clubs\.brooklyn\.cuny\.edu/i, { timeout: 15000 }).catch(() => {});
    }
    if (await isLoggedInClubPage(page)) return;
    await page.goto(returnUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    if (await isLoggedInClubPage(page)) return;
  }

  const title = await page.title().catch(() => '');
  await writeLoginDebug(page, `Login did not reach CampusGroups club page: ${title || page.url()}`);
  throw new Error(`Login did not reach the CampusGroups club page. Current page: ${title || page.url()}`);
}

function aboutUrl(club) {
  return `https://www.clubs.brooklyn.cuny.edu/feeds?type=club&type_id=${encodeURIComponent(club.campusGroupsClubId)}&tab=about`;
}

async function parseClubAboutPage(page, club) {
  const url = aboutUrl(club);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await loginIfNeeded(page, url);
  await page.waitForSelector('img.club-logo, .social-links, body', { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  return page.evaluate(() => {
    const logo = document.querySelector('img.club-logo');
    const socialLinks = Array.from(document.querySelectorAll('.social-links a[href], a[aria-label*="instagram" i], a[aria-label*="discord" i], a[aria-label*="whatsapp" i], a[href*="linktr.ee"], a[href*="linktree"]'))
      .map(a => a.href)
      .filter(Boolean);
    return {
      logoUrl: logo ? logo.src : '',
      socialUrls: [...new Set(socialLinks)]
    };
  });
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL returned from browser compression.');
  return {
    contentType: match[1],
    body: Buffer.from(match[2], 'base64')
  };
}

async function fetchImageSource(page, imageUrl) {
  const response = await page.request.get(imageUrl, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });
  if (!response.ok()) throw new Error(`logo download HTTP ${response.status()}`);

  const contentType = (response.headers()['content-type'] || 'image/png').split(';')[0].trim();
  if (!/^image\/(jpeg|jpg|png|webp|gif)/i.test(contentType)) {
    throw new Error(`Unexpected logo content type ${contentType || 'unknown'}`);
  }

  const body = await response.body();
  return {
    dataUrl: `data:${contentType};base64,${body.toString('base64')}`,
    bytes: body.length,
    contentType
  };
}

async function renderIcon(page, imageSource) {
  return page.evaluate(async ({ dataUrl, iconSizePx }) => {
    const sourceBlob = await fetch(dataUrl).then(response => response.blob());
    const bitmap = await createImageBitmap(sourceBlob);
    const canvas = document.createElement('canvas');
    canvas.width = iconSizePx;
    canvas.height = iconSizePx;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, iconSizePx, iconSizePx);
    const scale = iconSizePx / Math.max(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    ctx.drawImage(bitmap, (iconSizePx - width) / 2, (iconSizePx - height) / 2, width, height);
    bitmap.close?.();
    return canvas.toDataURL('image/png');
  }, { dataUrl: imageSource.dataUrl, iconSizePx: ICON_SIZE_PX });
}

async function uploadStorageData(storagePath, dataUrl) {
  const { body, contentType } = dataUrlToBuffer(dataUrl);
  const upload = await requestJson(storageUploadUrl(storagePath), {
    method: 'POST',
    body,
    headers: { 'Content-Type': contentType }
  });
  return {
    url: storagePublicUrl(upload.name || storagePath, upload.downloadTokens),
    path: upload.name || storagePath,
    bytes: body.length
  };
}

function storageSafeId(value) {
  return decodeEntities(value)
    .replace(/[\/\\?#\[\]*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'club';
}

function docIdForNewClub(club) {
  return storageSafeId(club.name);
}

function mergeLinks(about) {
  const links = [];
  for (const url of about.socialUrls || []) links.push({ label: 'Social Media', url });
  const seen = new Set();
  return links.filter(link => {
    const key = normalize(link.url).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function patchClub(docId, data, fieldPaths) {
  if (dryRun) {
    console.log(`DRY RUN patch ${docId}: ${fieldPaths.join(', ')}`);
    return;
  }
  await requestJson(firestoreDocumentUrl('clubs', docId, fieldPaths), {
    method: 'PATCH',
    body: JSON.stringify({ fields: firestoreFields(data) }),
    headers: { 'Content-Type': 'application/json' }
  });
}

async function createClub(docId, data) {
  if (dryRun) {
    console.log(`DRY RUN create ${docId}`);
    return;
  }
  await requestJson(firestoreDocumentUrl('clubs', docId), {
    method: 'PATCH',
    body: JSON.stringify({ fields: firestoreFields(data) }),
    headers: { 'Content-Type': 'application/json' }
  });
}

async function enrichNewClubs(browser, newClubs) {
  if (!newClubs.length) return new Map();
  const context = await browser.newContext();
  const page = await context.newPage();
  const enriched = new Map();
  try {
    const firstUrl = aboutUrl(newClubs[0]);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, firstUrl);
    await fs.mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(`Saved browser session state to ${AUTH_STATE_PATH}`);

    for (const club of newClubs) {
      const about = await parseClubAboutPage(page, club);
      let icon = { url: '', path: '' };
      const logoUrl = about.logoUrl || (!isDefaultLogo(club.listLogoUrl) ? club.listLogoUrl : '');
      if (logoUrl && !dryRun) {
        try {
          const imageSource = await fetchImageSource(page, logoUrl);
          const iconDataUrl = await renderIcon(page, imageSource);
          icon = await uploadStorageData(`clubs/${storageSafeId(club.name)}/icon.png`, iconDataUrl);
          console.log(`Uploaded club icon for ${club.name}: ${icon.bytes} bytes at ${icon.path}`);
        } catch (err) {
          console.warn(`Logo upload failed for ${club.name}: ${err.message.split('\n')[0]}`);
        }
      } else if (logoUrl) {
        console.log(`DRY RUN would fetch/upload logo for ${club.name}: ${logoUrl}`);
      }
      enriched.set(club.campusGroupsClubId, { ...about, icon });
    }
    await context.storageState({ path: AUTH_STATE_PATH });
  } finally {
    await context.close();
  }
  return enriched;
}

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  let summary;
  try {
    console.log(`Fetching public CampusGroups club list from ${listUrl}`);
    const [publicRows, existingClubDocs] = await Promise.all([
      fetchPublicClubList(browser),
      fetchCollection('clubs')
    ]);
    const clubs = publicRows.filter(club => !club.isDepartment);
    const departments = publicRows.length - clubs.length;
    const inactiveCount = clubs.filter(club => club.flag === 'inactive').length;
    const inactiveRatio = clubs.length ? inactiveCount / clubs.length : 0;

    console.log(`Found ${publicRows.length} public groups: ${clubs.length} clubs, ${departments} departments ignored.`);
    console.log(`${inactiveCount}/${clubs.length} clubs (${Math.round(inactiveRatio * 100)}%) have "Group Not Registered Yet".`);

    if (!clubs.length) throw new Error('No non-department clubs found on the public CampusGroups list.');
    if (inactiveRatio >= 2 / 3) console.log('At least two-thirds of clubs are not registered yet; continuing so Firebase active/inactive fields reflect CampusGroups.');

    const lookup = buildClubLookup(existingClubDocs);
    const existing = [];
    const newClubs = [];
    for (const club of clubs) {
      const match = findExistingClub(club, lookup);
      if (match) existing.push({ club, match });
      else newClubs.push(club);
    }
    console.log(`${existing.length} clubs matched Firebase. ${newClubs.length} new clubs need Firebase docs/icons.`);

    const enriched = await enrichNewClubs(browser, newClubs);
    let patched = 0;
    let descriptionsPatched = 0;
    let created = 0;

    for (const { club, match } of existing) {
      const updates = { flag: club.flag, active: club.active, inactive: !club.active };
      const fields = ['flag', 'active', 'inactive'];
      if (club.flag === 'active' && (match.data.description === '' || typeof match.data.description === 'undefined') && club.mission) {
        updates.description = club.mission;
        fields.push('description');
        descriptionsPatched += 1;
      }
      await patchClub(match.id, updates, fields);
      patched += 1;
    }

    for (const club of newClubs) {
      const about = enriched.get(club.campusGroupsClubId) || { socialUrls: [], icon: { url: '', path: '' } };
      const docId = docIdForNewClub(club);
      const doc = {
        name: club.name,
        clubId: club.name,
        campusGroupsClubId: club.campusGroupsClubId,
        sourceUrl: club.sourceUrl,
        subtitle: club.category,
        description: club.mission || '',
        links: mergeLinks(about),
        icon: about.icon?.url || '',
        iconPath: about.icon?.path || '',
        flag: club.flag,
        active: club.active,
        inactive: !club.active,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await createClub(docId, doc);
      created += 1;
    }

    summary = {
      dryRun,
      skipped: false,
      publicRows: publicRows.length,
      clubs: clubs.length,
      departments,
      inactiveCount,
      existing: existing.length,
      newClubs: newClubs.map(club => ({ name: club.name, campusGroupsClubId: club.campusGroupsClubId, flag: club.flag })),
      patched,
      descriptionsPatched,
      created
    };
  } finally {
    await browser.close();
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    if (summary) {
      await fs.writeFile(path.join(ARTIFACTS_DIR, 'club-status-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    }
  }

  console.log(`Club status scrape complete: ${summary?.skipped ? 'skipped flagging' : `${dryRun ? 'would patch' : 'patched'} ${summary?.patched || 0}, ${dryRun ? 'would create' : 'created'} ${summary?.created || 0}`}.`);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
