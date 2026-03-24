// Bella Language Tutor — Anthropic API Proxy
// Vercel serverless function — stores your API key safely server-side

const RATE_LIMIT_FREE = 20; // messages per day for free users
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory store (resets on cold start — fine for rate limiting)
const rateLimitStore = new Map();

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 0, windowStart: now });
    return { count: 0, windowStart: now };
  }
  return entry;
}

function incrementRateLimit(ip) {
  const entry = getRateLimit(ip);
  entry.count++;
  rateLimitStore.set(ip, entry);
  return entry.count;
}

export default async function handler(req, res) {
  // CORS — allow any origin (public app)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get client IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

  // Check if request includes a Pro token
  const authHeader = req.headers['authorization'];
  const isPro = authHeader && authHeader === `Bearer ${process.env.PRO_SECRET}`;

  // Rate limit free users
  if (!isPro) {
    const entry = getRateLimit(ip);
    if (entry.count >= RATE_LIMIT_FREE) {
      const resetIn = Math.ceil((RATE_WINDOW_MS - (Date.now() - entry.windowStart)) / 3600000);
      return res.status(429).json({
        error: {
          type: 'rate_limit',
          message: `Free limit reached (${RATE_LIMIT_FREE} messages/day). Resets in ~${resetIn}h. Upgrade to Pro for unlimited access.`,
          resetHours: resetIn
        }
      });
    }
    incrementRateLimit(ip);
  }

  // Forward to Anthropic
  try {
    const body = req.body;

    // Validate request structure
    if (!body.messages || !Array.isArray(body.messages)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-haiku-4-5-20251001',
        max_tokens: body.max_tokens || 1200,
        system: body.system,
        messages: body.messages,
      }),
    });

    const data = await anthropicRes.json();

    // Add rate limit info to response headers
    if (!isPro) {
      const entry = getRateLimit(ip);
      res.setHeader('X-RateLimit-Limit', RATE_LIMIT_FREE);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_FREE - entry.count));
    }

    return res.status(anthropicRes.status).json(data);

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({
      error: { message: 'Proxy server error. Please try again.' }
    });
  }
}
