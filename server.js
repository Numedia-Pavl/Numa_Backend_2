'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes       = require('./route-auth');
const employeeRoutes   = require('./route-employees');
const payrollRoutes    = require('./route-payroll');
const leaveRoutes      = require('./route-leave');
const attendanceRoutes = require('./route-attendance');
const userRoutes       = require('./route-users');
const dashboardRoutes  = require('./route-dashboard');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false }));

// Allow ALL origins — fixes "Failed to fetch"
app.use(cors({ origin: '*', credentials: false }));

const limiter     = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' }
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

app.use('/api/auth',       authLimiter, authRoutes);
app.use('/api/employees',  employeeRoutes);
app.use('/api/payroll',    payrollRoutes);
app.use('/api/leave',      leaveRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/users',      userRoutes);
app.use('/api/dashboard',  dashboardRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Server error' : err.message
  });
});

app.listen(PORT, () => {
  console.log('NUMA HRIS Backend running on port ' + PORT);
});

module.exports = app;
