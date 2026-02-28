// Math Solver AI - Local server (Groq backend)
// Usage:
//   npm run dev  (with GROQ_API_KEY set in .env)
//   Open http://localhost:3000

// Load .env file automatically
const fs = require('fs');
const envPath = require('path').join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.trim().split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

const http = require('http');
const https = require('https');
const path = require('path');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_HOST = 'api.groq.com';
const STATIC_ROOT = __dirname;
const MAX_CHAT_BYTES = 20_000_000;

const GROQ_MODELS_FALLBACK = [
  { name: 'meta-llama/llama-4-maverick-17b-128e-instruct' },
  { name: 'meta-llama/llama-4-scout-17b-16e-instruct' },
  { name: 'llama-3.3-70b-versatile' },
  { name: 'llama-3.1-8b-instant' },
  { name: 'llama3-70b-8192' },
  { name: 'llama3-8b-8192' },
  { name: 'gemma2-9b-it' },
  { name: 'mixtral-8x7b-32768' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

let requestCounter = 0;

function now() {
  return new Date().toISOString();
}

function log(level, message, extra = null) {
  const head = `[${now()}] [${level}]`;
  if (!extra) { console.log(`${head} ${message}`); return; }
  console.log(`${head} ${message}`, extra);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function jsonError(reqId, res, status, message, err = null) {
  log('ERROR', `[${reqId}] ${message}`, err ? { error: err.message, stack: err.stack } : undefined);
  sendJson(res, status, { error: { message } });
}

function readBody(req, res, reqId, limit, onDone) {
  let body = '';
  let done = false;
  let bytes = 0;

  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > limit) {
      if (!done) {
        done = true;
        jsonError(reqId, res, 413, `Request body too large (limit ${limit} bytes)`);
        req.destroy();
      }
      return;
    }
    body += chunk.toString('utf8');
  });

  req.on('end', () => { if (!done) onDone(body); });
  req.on('error', (err) => { if (!done) jsonError(reqId, res, 400, 'Failed to read request body', err); });
}

// ---- GROQ API HELPERS ----

function groqRequest(method, apiPath, body, onDone, onError) {
  if (!GROQ_API_KEY) {
    return onError(new Error('GROQ_API_KEY environment variable is not set. Start the server with: GROQ_API_KEY=your_key npm run dev'));
  }

  const bodyStr = body ? JSON.stringify(body) : null;

  const opts = {
    hostname: GROQ_HOST,
    port: 443,
    path: apiPath,
    method,
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 120_000,
  };

  if (bodyStr) {
    opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  const req = https.request(opts, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => onDone(res.statusCode, data));
  });

  req.on('timeout', () => { req.destroy(new Error('Groq request timed out')); });
  req.on('error', onError);

  if (bodyStr) req.write(bodyStr);
  req.end();
}

function listModels(reqId, res) {
  groqRequest('GET', '/openai/v1/models', null,
    (statusCode, data) => {
      if (statusCode >= 400) {
        log('WARN', `[${reqId}] Groq /openai/v1/models returned HTTP ${statusCode}`);
        return sendJson(res, 200, { models: GROQ_MODELS_FALLBACK });
      }

      let parsed;
      try { parsed = JSON.parse(data); } catch {
        log('WARN', `[${reqId}] Groq /openai/v1/models returned non-JSON`);
        return sendJson(res, 200, { models: GROQ_MODELS_FALLBACK });
      }

      // Groq returns OpenAI-style { object: "list", data: [...] }
      const rawModels = Array.isArray(parsed?.data) ? parsed.data : [];

      // Filter to chat-capable models only (skip whisper, guard, embedding models, etc.)
      const chatModels = rawModels
        .filter((m) => {
          const id = typeof m?.id === 'string' ? m.id : '';
          if (!id) return false;
          // Skip non-chat models (audio, embeddings, guard models, etc.)
          if (/whisper|tts|embed|guard/.test(id)) return false;
          return true;
        })
        .map((m) => ({ name: m.id }));

      // If nothing survived filtering, fall back to the hardcoded list
      const models = chatModels.length ? chatModels : GROQ_MODELS_FALLBACK;
      sendJson(res, 200, { models });
    },
    (err) => {
      log('WARN', `[${reqId}] Cannot fetch model list from Groq: ${err.message}`);
      // Return fallback list instead of an error so the UI still works
      sendJson(res, 200, { models: GROQ_MODELS_FALLBACK });
    }
  );
}

function doGroqChat(reqId, res, model, messages) {
  // Convert messages to OpenAI-compatible format.
  // If images are present, send multimodal content blocks for vision models.
  const groqMessages = messages.map((m) => {
    const hasImages = Array.isArray(m?.images) && m.images.length > 0;
    if (!hasImages) {
      return { role: m.role, content: m.content };
    }

    const content = [];
    if (m.content) {
      content.push({ type: 'text', text: String(m.content) });
    }

    for (const img of m.images) {
      // Support both legacy string images (base64-only) and structured objects.
      const data = typeof img === 'string' ? img : String(img?.data || '');
      const mime = typeof img === 'object' && img?.mime ? String(img.mime) : 'image/png';
      if (!data) continue;
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${data}` },
      });
    }

    if (!content.length) {
      return { role: m.role, content: m.content || '' };
    }
    return { role: m.role, content };
  });

  const body = {
    model,
    messages: groqMessages,
    temperature: 0.4,
    max_tokens: 1500,
    stream: false,
  };

  log('INFO', `[${reqId}] Chat request -> Groq model=${model}`);

  groqRequest('POST', '/openai/v1/chat/completions', body,
    (statusCode, data) => {
      let json;
      try { json = JSON.parse(data); } catch {
        return jsonError(reqId, res, 502, `Bad JSON from Groq: ${data.slice(0, 180)}`);
      }

      if (statusCode >= 400) {
        const message = json?.error?.message || json?.message || 'Groq returned an error';
        return jsonError(reqId, res, statusCode, `Groq error: ${message}`);
      }

      const text = json?.choices?.[0]?.message?.content;
      if (!text) {
        const preview = JSON.stringify(json).slice(0, 280);
        return jsonError(reqId, res, 502, `Groq returned empty content. Response preview: ${preview}`);
      }

      sendJson(res, 200, { text });
    },
    (err) => {
      if (err.message.includes('GROQ_API_KEY')) {
        return jsonError(reqId, res, 401, err.message, err);
      }
      return jsonError(reqId, res, 502, `Groq request failed: ${err.message}`, err);
    }
  );
}

function proxyGroqChat(reqId, res, body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    return jsonError(reqId, res, 400, 'Invalid JSON body');
  }

  if (!parsed?.model || !Array.isArray(parsed?.messages)) {
    return jsonError(reqId, res, 400, 'Invalid payload. Expected { model, messages[] }');
  }
  doGroqChat(reqId, res, parsed.model, parsed.messages);
}

// ---- STATIC FILES ----

function serveStatic(reqId, reqPath, res) {
  const file = reqPath === '/' ? '/math-solver.html' : reqPath;
  const root = `${path.resolve(STATIC_ROOT)}${path.sep}`;
  const resolved = path.resolve(STATIC_ROOT, `.${file}`);

  if (!resolved.startsWith(root)) {
    return jsonError(reqId, res, 403, 'Forbidden');
  }

  fs.readFile(resolved, (err, data) => {
    if (err) return jsonError(reqId, res, 404, `Not found: ${file}`);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
}

// ---- HTTP HANDLER ----

function requestHandler(req, res) {
  const reqId = ++requestCounter;
  const startedAt = Date.now();
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    log('HTTP', `[${reqId}] ${req.method} ${pathname} -> ${res.statusCode} (${ms}ms)`);
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/health') {
    const keyStatus = GROQ_API_KEY ? 'set' : 'MISSING';
    return sendJson(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), apiKey: keyStatus });
  }

  if (req.method === 'GET' && pathname === '/api/models') {
    return listModels(reqId, res);
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    return readBody(req, res, reqId, MAX_CHAT_BYTES, (body) => proxyGroqChat(reqId, res, body));
  }

  if (pathname.startsWith('/api/')) {
    return jsonError(reqId, res, 404, `Unknown API route: ${req.method} ${pathname}`);
  }

  serveStatic(reqId, pathname, res);
}

if (process.env.VERCEL) {
  // Vercel serverless function entrypoint
  module.exports = requestHandler;
} else {
  // Local Node server mode
  const server = http.createServer(requestHandler);

  server.listen(PORT, () => {
    log('INFO', 'Math Solver AI server is running (Groq backend)');
    log('INFO', `URL: http://localhost:${PORT}`);
    if (!GROQ_API_KEY) {
      log('WARN', '*** GROQ_API_KEY is not set! Set it before starting: GROQ_API_KEY=your_key npm run dev ***');
    } else {
      log('INFO', 'Groq API key detected. Ready to handle requests.');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('ERROR', `Port ${PORT} is already in use.`);
      log('ERROR', `Use: npx kill-port ${PORT} or set PORT to a different value.`);
    } else {
      log('ERROR', `Server failed to start: ${err.message}`, err);
    }
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    log('FATAL', `Uncaught exception: ${err.message}`, err);
  });

  process.on('unhandledRejection', (reason) => {
    log('FATAL', 'Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : reason,
    });
  });
}
