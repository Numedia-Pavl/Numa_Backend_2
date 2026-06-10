require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ─── SECURITY HEADERS ────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));

// ─── CORS ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '*').split(',').map(o => o.trim());
app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// ─── BODY PARSING ─────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── RATE LIMITING ────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,                  // 300 req / 15 min per IP (enough for 100 employees)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' }
}));

app.use('/api/auth/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,                   // Strict: 15 login attempts per 15 min
  message: { error: 'Too many login attempts. Please wait 15 minutes.' }
}));

// ─── REQUEST LOGGER (lightweight, no external lib) ───────────
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ─── HEALTH CHECK (used by Railway & uptime monitors) ─────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'NUMA HRIS Backend',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (_req, res) => res.json({ message: 'NUMA HRIS API is running.' }));

// ─── ROUTES ───────────────────────────────────────────────────
app.use('/api/auth',        require('./route-auth'));
app.use('/api/employees',   require('./route-employees'));
app.use('/api/users',       require('./route-users'));
app.use('/api/departments', require('./route-departments'));
app.use('/api/payroll',     require('./route-payroll'));
app.use('/api/attendance',  require('./route-attendance'));
app.use('/api/leave',       require('./route-leave'));
app.use('/api/documents',   require('./route-documents'));
app.use('/api/loans',       require('./route-loans'));
app.use('/api/reports',     require('./route-reports'));
app.use('/api/settings',    require('./route-settings'));

// ─── GLOBAL 404 ───────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message, err.stack);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500
      ? 'Something went wrong on our end. Please try again.'
      : err.message
  });
});

// ─── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 NUMA HRIS Backend v2.0 running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Env:    ${process.env.NODE_ENV || 'development'}\n`);
});
