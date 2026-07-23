const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT_DIR = __dirname;
const ROUTES_DIR_PATH = path.join(ROOT_DIR, 'routes');
const FLEET_BUILDS_DIR_PATH = path.join(ROOT_DIR, 'images', 'Builds');
const ENQUIRIES_LOG_PATH = path.join(ROOT_DIR, 'data', 'enquiries-log.json');
const PORT = Number(process.env.PORT || 8080);
const ENQUIRY_TO = process.env.ENQUIRY_TO || 'chris.robert.watson@gmail.com,cycleryraglan@gmail.com';

let nodemailerModule = null;
let transporter = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

const IMAGE_FILE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (raw.length > 2_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function readRoutesCatalog() {
  let dirEntries = [];
  try {
    dirEntries = await fsp.readdir(ROUTES_DIR_PATH, {withFileTypes: true});
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const routes = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;

    try {
      const routeDirPath = path.join(ROUTES_DIR_PATH, entry.name);
      const routeFiles = await fsp.readdir(routeDirPath, {withFileTypes: true});
      const jsonFiles = routeFiles
        .filter(file => file.isFile() && file.name.toLowerCase().endsWith('.json'))
        .map(file => file.name)
        .sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
      if (!jsonFiles.length) continue;

      const routeFilePath = path.join(routeDirPath, jsonFiles[0]);
      const raw = await fsp.readFile(routeFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const highlightImage = getRouteHighlightImage(parsed);
        const galleryPhotos = await getRouteGalleryPhotos(routeDirPath, entry.name, highlightImage);
        routes.push({
          ...parsed,
          highlightImage,
          galleryPhotos
        });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`Failed to read route metadata for ${entry.name}: ${err.message}`);
      }
    }
  }

  return routes;
}

function normalizeImagePath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function getRouteHighlightImage(route) {
  const direct = typeof route?.highlightImage === 'string' ? route.highlightImage.trim() : '';
  if (direct) return direct;

  const routeFile = String(route?.file || '').trim().replace(/\\/g, '/');
  if (/^routes\//i.test(routeFile) && routeFile.includes('/')) {
    const folder = routeFile.split('/').slice(0, -1).join('/');
    if (folder) return `${folder}/a.webp`;
  }

  const routeId = sanitizeId(route?.id || '').trim();
  if (routeId) return `routes/${routeId}/a.webp`;

  if (Array.isArray(route?.photos)) {
    const firstPhoto = route.photos
      .map(item => String(item || '').trim())
      .find(Boolean);
    if (firstPhoto) return firstPhoto;
  }

  return '';
}

async function getRouteGalleryPhotos(routeDirPath, routeFolderName, highlightImage) {
  const normalizedHighlight = normalizeImagePath(highlightImage);

  let files = [];
  try {
    files = await fsp.readdir(routeDirPath, {withFileTypes: true});
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  return files
    .filter(file => file.isFile() && IMAGE_FILE_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
    .map(file => `routes/${routeFolderName}/${file.name}`)
    .filter(imgPath => normalizeImagePath(imgPath) !== normalizedHighlight)
    .sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
}

async function listFleetBuildImages() {
  let files = [];
  try {
    files = await fsp.readdir(FLEET_BUILDS_DIR_PATH, {withFileTypes: true});
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  return files
    .filter(file => file.isFile() && IMAGE_FILE_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}))
    .map(file => `images/Builds/${encodeURIComponent(file.name)}`)
}

function renderFleetImagesScript(images) {
  return `<script>globalThis.DIRK_FLEET_IMAGES = ${JSON.stringify(images, null, 2)};<\/script>`;
}

function getRouteDataFileName(route) {
  const baseName = sanitizeId(route?.name || route?.id || '').trim();
  const fallback = sanitizeId(route?.id || 'route');
  return `${baseName || fallback || 'route'}.json`;
}

async function removeRouteJsonFiles(routeId) {
  const routeDir = path.join(ROUTES_DIR_PATH, routeId);
  let files = [];
  try {
    files = await fsp.readdir(routeDir, {withFileTypes: true});
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (const file of files) {
    if (!file.isFile()) continue;
    if (!file.name.toLowerCase().endsWith('.json')) continue;
    await fsp.unlink(path.join(routeDir, file.name));
  }
}

async function writeRouteFile(route) {
  const routeDir = path.join(ROUTES_DIR_PATH, route.id);
  const routeFilePath = path.join(routeDir, getRouteDataFileName(route));
  const tmpPath = `${routeFilePath}.tmp`;
  const json = `${JSON.stringify(route, null, 2)}\n`;
  await fsp.mkdir(routeDir, {recursive: true});
  const existingFiles = await fsp.readdir(routeDir, {withFileTypes: true});
  for (const file of existingFiles) {
    if (!file.isFile()) continue;
    if (!file.name.toLowerCase().endsWith('.json')) continue;
    const filePath = path.join(routeDir, file.name);
    if (filePath !== routeFilePath) {
      await fsp.unlink(filePath);
    }
  }
  await fsp.writeFile(tmpPath, json, 'utf8');
  await fsp.rename(tmpPath, routeFilePath);
}

async function appendEnquiryLog(entry) {
  await fsp.mkdir(path.dirname(ENQUIRIES_LOG_PATH), {recursive: true});

  let current = [];
  try {
    const raw = await fsp.readFile(ENQUIRIES_LOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) current = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  current.push({
    id,
    loggedAt: new Date().toISOString(),
    ...entry
  });

  // Keep log size bounded so this file does not grow forever.
  if (current.length > 2000) {
    current = current.slice(-2000);
  }

  const tmpPath = `${ENQUIRIES_LOG_PATH}.tmp`;
  const json = `${JSON.stringify(current, null, 2)}\n`;
  await fsp.writeFile(tmpPath, json, 'utf8');
  await fsp.rename(tmpPath, ENQUIRIES_LOG_PATH);
}

function getRequestIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').trim();
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(req.headers.host || '').split(',')[0].trim();
  if (!host) return '';

  const protocol = forwardedProto || (/localhost|127\.0\.0\.1/i.test(host) ? 'http' : 'https');
  return `${protocol}://${host}`;
}

function toAbsoluteUrl(origin, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!origin) return raw;

  const normalized = raw.replace(/^\.?\//, '');
  return `${origin}/${encodeURI(normalized)}`;
}

function getRouteShareDefaults(origin, currentPathWithSearch) {
  const fallbackDescription = 'Detailed bikepacking route profiles with maps, GPX links, route stats, and recommended setup advice for New Zealand rides.';
  const fallbackUrl = currentPathWithSearch || '/route.html';
  const pageUrl = origin ? `${origin}${fallbackUrl}` : fallbackUrl;
  const fallbackImage = toAbsoluteUrl(origin, 'images/Logo.webp') || 'images/Logo.webp';

  return {
    title: 'Route Details · NZ Bikepacking Rentals',
    description: fallbackDescription,
    url: pageUrl,
    image: fallbackImage
  };
}

async function getRouteShareMeta(req, urlObj) {
  const origin = getRequestOrigin(req);
  const pathWithSearch = `${urlObj.pathname || '/route.html'}${urlObj.search || ''}`;
  const defaults = getRouteShareDefaults(origin, pathWithSearch);
  const routeId = sanitizeId(urlObj.searchParams.get('id') || '');

  if (!routeId) return defaults;

  try {
    const routes = await readRoutesCatalog();
    const route = routes.find(item => sanitizeId(item?.id || '') === routeId);
    if (!route) return defaults;

    const canonicalRouteId = sanitizeId(route.id || routeId) || routeId;
    const routeTitle = String(route.name || '').trim() || 'Route Details';
    const routeDescription = String(route.description || '').trim() || defaults.description;
    const highlightImage = getRouteHighlightImage(route);
    const shareImage = toAbsoluteUrl(origin, highlightImage) || defaults.image;
    const canonicalPath = `/route.html?id=${encodeURIComponent(canonicalRouteId)}`;

    return {
      title: `${routeTitle} · NZ Bikepacking Rentals`,
      description: routeDescription,
      url: origin ? `${origin}${canonicalPath}` : canonicalPath,
      image: shareImage
    };
  } catch {
    return defaults;
  }
}

function renderRouteShareMetaBlock(meta) {
  const title = escapeHtmlAttribute(meta.title);
  const description = escapeHtmlAttribute(meta.description);
  const url = escapeHtmlAttribute(meta.url);
  const image = escapeHtmlAttribute(meta.image);

  return `<!--ROUTE_SHARE_META_START-->
<link rel="canonical" href="${url}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="NZ Bikepacking Rentals" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${image}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="twitter:image" content="${image}" />
<!--ROUTE_SHARE_META_END-->`;
}

async function injectRouteShareMeta(rawHtml, req, urlObj) {
  const meta = await getRouteShareMeta(req, urlObj);
  const dynamicBlock = renderRouteShareMetaBlock(meta);
  const markerPattern = /<!--ROUTE_SHARE_META_START-->[\s\S]*?<!--ROUTE_SHARE_META_END-->/;

  if (markerPattern.test(rawHtml)) {
    return rawHtml.replace(markerPattern, dynamicBlock);
  }

  return rawHtml.replace('</head>', `${dynamicBlock}\n</head>`);
}

function routePayloadOrNull(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const copy = {...payload};
  if (!copy.id && copy.name) {
    copy.id = sanitizeId(copy.name);
  }
  copy.id = sanitizeId(copy.id);

  if (!copy.id || !copy.name || !copy.file) {
    return null;
  }

  if (copy.days !== undefined) {
    const rawDays = String(copy.days).trim();
    const num = Number(rawDays);
    if (Number.isFinite(num)) {
      copy.days = Math.round(num);
    } else {
      const rangeMatch = rawDays.match(/(\d+(?:\.\d+)?)\s*[-\u2013\u2014]\s*(\d+(?:\.\d+)?)/);
      if (rangeMatch) {
        const a = Math.round(Number(rangeMatch[1]));
        const b = Math.round(Number(rangeMatch[2]));
        if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
          const min = Math.min(a, b);
          const max = Math.max(a, b);
          copy.days = `${min}-${max}`;
        } else {
          copy.days = rawDays;
        }
      } else {
        copy.days = rawDays;
      }
    }
  }

  if (!Array.isArray(copy.moreInfo)) copy.moreInfo = [];
  copy.moreInfo = copy.moreInfo
    .map(item => {
      if (typeof item === 'string') {
        const value = item.trim();
        return value || null;
      }

      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const url = String(item.url || item.href || item.link || '').trim();
        if (!url) return null;
        const label = String(item.label || item.text || item.title || '').trim();
        return label ? {label, url} : url;
      }

      return null;
    })
    .filter(Boolean);
  if (typeof copy.highlightImage !== 'string') copy.highlightImage = '';
  copy.highlightImage = copy.highlightImage.trim();
  if (!copy.highlightImage && Array.isArray(copy.photos)) {
    const legacyFirstPhoto = copy.photos.map(item => String(item || '').trim()).find(Boolean);
    if (legacyFirstPhoto) copy.highlightImage = legacyFirstPhoto;
  }
  delete copy.photos;
  if (!Array.isArray(copy.youtubeVideos)) copy.youtubeVideos = [];
  copy.youtubeVideos = copy.youtubeVideos.slice(0, 3);
  if (!Array.isArray(copy.tags)) copy.tags = [];
  if (copy.disabled === undefined) copy.disabled = false;

  return copy;
}

function sanitizeText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function currency(amount) {
  const num = Number(amount || 0);
  return `$${Number.isFinite(num) ? num : 0}`;
}

function formatEnquiryMail(payload) {
  const contact = payload.contact || {};
  const booking = payload.booking || {};
  const pricing = payload.pricing || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const page = payload.page || {};

  const contactEmail = sanitizeText(contact.email, 'Not provided');
  const contactPhone = sanitizeText(contact.phone, 'Not provided');
  const startDate = sanitizeText(booking.startDate, 'Not set');
  const endDate = sanitizeText(booking.endDate, 'Not set');
  const weeks = Number(booking.weeks || 0);
  const frameSize = sanitizeText(booking.frameSize, 'Not set');

  const itemLines = items.length
    ? items.map((item, idx) => {
        const label = sanitizeText(item.name, 'Unnamed item');
        const val = sanitizeText(item.val, '$0/week');
        return `${idx + 1}. ${label} (${val})`;
      })
    : ['No items selected'];

  const subject = `New Bike Builder Enquiry - ${contactEmail}`;
  const text = [
    'New bike builder enquiry received.',
    '',
    'Contact',
    `Email: ${contactEmail}`,
    `Phone: ${contactPhone}`,
    '',
    'Trip',
    `Start: ${startDate}`,
    `End: ${endDate}`,
    `Weeks: ${weeks || 'Not set'}`,
    `Frame size: ${frameSize}`,
    '',
    'Selected kit',
    ...itemLines,
    '',
    'Pricing',
    `Weekly total: ${currency(pricing.weeklyTotal)}`,
    `Subtotal: ${currency(pricing.subtotal)}`,
    `Discount: ${Number(pricing.discountPercent || 0)}%`,
    `Discount amount: ${currency(pricing.discountAmount)}`,
    `Total: ${currency(pricing.total)}`,
    '',
    `Page URL: ${sanitizeText(page.url, 'Unknown')}`,
    `Submitted: ${new Date().toISOString()}`
  ].join('\n');

  return {subject, text, replyTo: contactEmail};
}

function formatContactMail(payload) {
  const name = sanitizeText(payload?.name, 'Not provided');
  const email = sanitizeText(payload?.email, 'Not provided');
  const phone = sanitizeText(payload?.phone, 'Not provided');
  const route = sanitizeText(payload?.route, 'Not provided');
  const message = sanitizeText(payload?.message, 'Not provided');
  const pageUrl = sanitizeText(payload?.page?.url, 'Unknown');

  const subject = `New Contact Enquiry - ${email}`;
  const text = [
    'New contact enquiry received.',
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Route Interested In: ${route}`,
    '',
    'Trip Details:',
    message,
    '',
    `Page URL: ${pageUrl}`,
    `Submitted: ${new Date().toISOString()}`
  ].join('\n');

  return {subject, text, replyTo: email};
}

function isValidEnquiryPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const email = sanitizeText(payload?.contact?.email, '');
  if (!email || !email.includes('@')) return false;
  if (!sanitizeText(payload?.booking?.startDate, '')) return false;
  if (!sanitizeText(payload?.booking?.endDate, '')) return false;
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return false;
  return true;
}

function isValidContactPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const email = sanitizeText(payload?.email, '');
  const message = sanitizeText(payload?.message, '');
  if (!email || !email.includes('@')) return false;
  if (!message) return false;
  return true;
}

function getMailer() {
  if (!nodemailerModule) {
    // Lazy require to allow the rest of the server to run even if mailing is not used.
    nodemailerModule = require('nodemailer');
  }

  if (transporter) return transporter;

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = (process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';

  if (!user || !pass) {
    throw new Error('SMTP credentials missing. Set SMTP_USER and SMTP_PASS environment variables.');
  }

  transporter = nodemailerModule.createTransport({
    host,
    port,
    secure,
    auth: {user, pass}
  });

  return transporter;
}

async function handleApi(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/contact-enquiries') {
    try {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || '{}');

      if (!isValidContactPayload(payload)) {
        return sendJson(res, 400, {error: 'Invalid contact payload. Email and message are required.'});
      }

      let mailSent = false;
      let mailError = '';

      try {
        const mailer = getMailer();
        const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
        const message = formatContactMail(payload);

        await mailer.sendMail({
          to: ENQUIRY_TO,
          from: fromAddress,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.text
        });

        mailSent = true;
      } catch (mailErr) {
        mailError = mailErr && mailErr.message ? String(mailErr.message) : 'Unknown email transport error';
      }

      try {
        await appendEnquiryLog({
          source: {
            ip: getRequestIp(req),
            userAgent: sanitizeText(req.headers['user-agent'], 'unknown')
          },
          contact: {
            name: sanitizeText(payload?.name, ''),
            email: sanitizeText(payload?.email, ''),
            phone: sanitizeText(payload?.phone, ''),
            route: sanitizeText(payload?.route, ''),
            message: sanitizeText(payload?.message, '')
          },
          page: payload?.page || {},
          mail: {
            sent: mailSent,
            error: mailError || null,
            recipient: ENQUIRY_TO
          }
        });
      } catch (logErr) {
        console.error('Failed to append contact enquiry log:', logErr);
      }

      if (!mailSent) {
        return sendJson(res, 500, {error: `Failed to send enquiry email: ${mailError}`});
      }

      return sendJson(res, 200, {ok: true});
    } catch (err) {
      console.error('Failed to send contact enquiry email:', err);
      const detail = err && err.message ? String(err.message) : 'Unknown email transport error';
      return sendJson(res, 500, {error: `Failed to send enquiry email: ${detail}`});
    }
  }

  if (req.method === 'POST' && pathname === '/api/enquiries') {
    try {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || '{}');

      if (!isValidEnquiryPayload(payload)) {
        return sendJson(res, 400, {error: 'Invalid enquiry payload.'});
      }

      let mailSent = false;
      let mailError = '';

      try {
        const mailer = getMailer();
        const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
        const message = formatEnquiryMail(payload);

        await mailer.sendMail({
          to: ENQUIRY_TO,
          from: fromAddress,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.text
        });

        mailSent = true;
      } catch (mailErr) {
        mailError = mailErr && mailErr.message ? String(mailErr.message) : 'Unknown email transport error';
      }

      try {
        await appendEnquiryLog({
          source: {
            ip: getRequestIp(req),
            userAgent: sanitizeText(req.headers['user-agent'], 'unknown')
          },
          contact: payload.contact || {},
          booking: payload.booking || {},
          pricing: payload.pricing || {},
          items: Array.isArray(payload.items) ? payload.items : [],
          page: payload.page || {},
          mail: {
            sent: mailSent,
            error: mailError || null,
            recipient: ENQUIRY_TO
          }
        });
      } catch (logErr) {
        console.error('Failed to append enquiry log:', logErr);
      }

      if (!mailSent) {
        return sendJson(res, 500, {error: `Failed to send enquiry email: ${mailError}`});
      }

      return sendJson(res, 200, {ok: true});
    } catch (err) {
      console.error('Failed to send enquiry email:', err);
      const detail = err && err.message ? String(err.message) : 'Unknown email transport error';
      return sendJson(res, 500, {error: `Failed to send enquiry email: ${detail}`});
    }
  }

  if (req.method === 'GET' && pathname === '/api/routes') {
    try {
      const catalog = await readRoutesCatalog();
      return sendJson(res, 200, catalog);
    } catch (err) {
      return sendJson(res, 500, {error: `Failed to read routes: ${err.message}`});
    }
  }

  if (req.method === 'GET' && pathname === '/api/fleet-images') {
    try {
      const images = await listFleetBuildImages();
      return sendJson(res, 200, images);
    } catch (err) {
      return sendJson(res, 500, {error: `Failed to read fleet images: ${err.message}`});
    }
  }

  if (req.method === 'POST' && pathname === '/api/routes') {
    try {
      const rawBody = await readRequestBody(req);
      const payload = routePayloadOrNull(JSON.parse(rawBody || '{}'));
      if (!payload) return sendJson(res, 400, {error: 'Invalid route payload. Required: id/name/file.'});

      const catalog = await readRoutesCatalog();
      if (catalog.some(route => String(route.id) === payload.id)) {
        return sendJson(res, 409, {error: `Route id already exists: ${payload.id}`});
      }

      await writeRouteFile(payload);
      return sendJson(res, 201, payload);
    } catch (err) {
      return sendJson(res, 500, {error: `Failed to add route: ${err.message}`});
    }
  }

  const routeIdMatch = pathname.match(/^\/api\/routes\/([^/]+)$/);
  if (!routeIdMatch) {
    return sendJson(res, 404, {error: 'Not found'});
  }

  const id = decodeURIComponent(routeIdMatch[1]);

  if (req.method === 'PUT') {
    try {
      const rawBody = await readRequestBody(req);
      const payload = routePayloadOrNull(JSON.parse(rawBody || '{}'));
      if (!payload) return sendJson(res, 400, {error: 'Invalid route payload. Required: id/name/file.'});

      const catalog = await readRoutesCatalog();
      const idx = catalog.findIndex(route => String(route.id) === id);
      if (idx < 0) return sendJson(res, 404, {error: `Route not found: ${id}`});

      const duplicateId = catalog.some((route, routeIdx) => routeIdx !== idx && String(route.id) === payload.id);
      if (duplicateId) return sendJson(res, 409, {error: `Another route already uses id: ${payload.id}`});

      await writeRouteFile(payload);
      if (payload.id !== id) {
        await removeRouteJsonFiles(id);
      }
      return sendJson(res, 200, payload);
    } catch (err) {
      return sendJson(res, 500, {error: `Failed to update route: ${err.message}`});
    }
  }

  if (req.method === 'PATCH') {
    try {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || '{}');
      const disabled = payload?.disabled;
      if (typeof disabled !== 'boolean') {
        return sendJson(res, 400, {error: 'PATCH body must include boolean "disabled".'});
      }

      const catalog = await readRoutesCatalog();
      const idx = catalog.findIndex(route => String(route.id) === id);
      if (idx < 0) return sendJson(res, 404, {error: `Route not found: ${id}`});

      const updated = {...catalog[idx], disabled};
      await writeRouteFile(updated);
      return sendJson(res, 200, updated);
    } catch (err) {
      return sendJson(res, 500, {error: `Failed to patch route: ${err.message}`});
    }
  }

  return sendJson(res, 405, {error: `Method not allowed: ${req.method}`});
}

function safeResolvePath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const candidate = decoded === '/' ? '/index.html' : decoded;
  const absolute = path.resolve(ROOT_DIR, `.${candidate}`);
  if (!absolute.startsWith(ROOT_DIR)) return null;
  return absolute;
}

async function serveStatic(req, res, urlObj) {
  const pathname = urlObj.pathname;
  const filePath = safeResolvePath(pathname);
  if (!filePath) {
    return sendText(res, 403, 'Forbidden');
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      return sendText(res, 403, 'Forbidden');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    if (path.resolve(filePath) === path.join(ROOT_DIR, 'index.html')) {
      const rawHtml = await fsp.readFile(filePath, 'utf8');
      const images = await listFleetBuildImages();
      const html = rawHtml.replace('<!--FLEET_IMAGES-->', renderFleetImagesScript(images));
      res.writeHead(200, {'Content-Type': mime});
      return res.end(html, 'utf8');
    }

    if (path.resolve(filePath) === path.join(ROOT_DIR, 'route.html')) {
      const rawHtml = await fsp.readFile(filePath, 'utf8');
      const html = await injectRouteShareMeta(rawHtml, req, urlObj);
      res.writeHead(200, {'Content-Type': mime});
      return res.end(html, 'utf8');
    }

    res.writeHead(200, {'Content-Type': mime});
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return sendText(res, 404, 'Not found');
    }
    return sendText(res, 500, `Static file error: ${err.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }

    return await serveStatic(req, res, url);
  } catch (err) {
    return sendJson(res, 500, {error: `Server error: ${err.message}`});
  }
});

async function bootstrap() {
  server.listen(PORT, () => {
    console.log(`DIRK BIKEPACKING server running at http://localhost:${PORT}`);
    console.log('Admin page: http://localhost:' + PORT + '/admin.html');
  });
}

bootstrap();
