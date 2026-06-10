require('dotenv').config();
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { supabase } = require('./supabase');
const auth    = require('./authMiddleware');

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = '8h';

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (error || !user)
      return res.status(401).json({ error: 'Incorrect email or password.' });

    if (user.employment_status === 'inactive')
      return res.status(403).json({
        error: 'Your account is deactivated. Contact your HR administrator.'
      });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Incorrect email or password.' });

    // Resolve linked employee record
    const { data: emp } = await supabase
      .from('employees')
      .select('id, employee_id')
      .eq('email', user.email)
      .maybeSingle();

    // Update last login (non-blocking)
    supabase.from('users').update({ last_login: new Date() }).eq('id', user.id).then(() => {});

    const token = makeToken(user, emp?.id);

    res.json({
      token,
      user: publicUser(user, emp)
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/register  — Self-service signup
//
// Flow:
//  1. Validate input
//  2. Create user account (roles: ['employee'] by default)
//  3. If HR already imported an employee record with this email
//     → link it (user_id + update status)
//     Otherwise → create a new blank employee record
//  4. Return JWT so user is logged in immediately
// ─────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { first_name, last_name, email, password, confirm_password } = req.body;

    // ── Validate ──────────────────────────────────────────────
    const errs = [];
    if (!first_name?.trim())  errs.push('First name is required.');
    if (!last_name?.trim())   errs.push('Last name is required.');
    if (!email?.trim())       errs.push('Email is required.');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push('Enter a valid email address.');
    if (!password)            errs.push('Password is required.');
    else if (password.length < 8) errs.push('Password must be at least 8 characters.');
    if (confirm_password !== undefined && password !== confirm_password)
      errs.push('Passwords do not match.');
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });

    const cleanEmail = email.toLowerCase().trim();

    // ── Check duplicate ──────────────────────────────────────
    const { data: existing } = await supabase
      .from('users').select('id').eq('email', cleanEmail).maybeSingle();

    if (existing)
      return res.status(409).json({
        error: 'This email is already registered. Please sign in.',
        redirect_to_login: true
      });

    // ── Create user ──────────────────────────────────────────
    const password_hash = await bcrypt.hash(password, 10);

    const { data: user, error: uErr } = await supabase
      .from('users')
      .insert({
        first_name       : first_name.trim(),
        last_name        : last_name.trim(),
        email            : cleanEmail,
        password_hash,
        roles            : ['employee'],
        employment_type  : 'probationary',
        employment_status: 'active',
      })
      .select()
      .single();

    if (uErr) throw uErr;

    // ── Link or create employee record ────────────────────────
    let empId = null;
    let linked = false;

    const { data: preloaded } = await supabase
      .from('employees')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (preloaded) {
      // HR pre-loaded this person via CSV → just link
      await supabase
        .from('employees')
        .update({ user_id: user.id, employment_status: 'active' })
        .eq('id', preloaded.id);
      empId  = preloaded.id;
      linked = true;
    } else {
      // Brand new person — create a basic employee record
      const { count } = await supabase
        .from('employees')
        .select('*', { count: 'exact', head: true });

      const year = new Date().getFullYear();
      const empNumber = `EMP-${year}-${String((count || 0) + 1).padStart(3, '0')}`;

      const { data: emp } = await supabase
        .from('employees')
        .insert({
          employee_id      : empNumber,
          first_name       : first_name.trim(),
          last_name        : last_name.trim(),
          email            : cleanEmail,
          user_id          : user.id,
          employment_type  : 'probationary',
          employment_status: 'active',
          basic_salary     : 0,  // HR fills in later
        })
        .select('id')
        .single();
      empId = emp?.id;
    }

    const token = makeToken(user, empId);

    // ── Activity log ──────────────────────────────────────────
    supabase.from('activity_logs').insert({
      user_id   : user.id,
      user_email: user.email,
      action    : 'SELF_REGISTER',
      details   : { linked_to_existing: linked, ip: req.ip }
    }).then(() => {});

    res.status(201).json({
      message : `Welcome to NUMA HRIS, ${first_name}!`,
      token,
      user    : publicUser(user, { id: empId }),
      linked,  // true = existing HR record found & linked
    });

  } catch (err) {
    console.error('Register error:', err.message);
    if (err.code === '23505')
      return res.status(409).json({
        error: 'This email is already registered. Please sign in.',
        redirect_to_login: true
      });
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────
router.get('/me', auth.verify, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, roles, employment_status, last_login, created_at')
      .eq('id', req.user.id)
      .single();

    const { data: emp } = await supabase
      .from('employees')
      .select('id, employee_id, first_name, last_name, position, department, basic_salary, employment_type, date_hired, profile_photo')
      .eq('email', user.email)
      .maybeSingle();

    res.json({ ...user, employee: emp || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/change-password
// ─────────────────────────────────────────────────────────────
router.post('/change-password', auth.verify, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Both current and new password are required.' });
    if (new_password.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });

    const { data: user } = await supabase
      .from('users').select('password_hash').eq('id', req.user.id).single();

    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok)
      return res.status(401).json({ error: 'Current password is incorrect.' });

    await supabase
      .from('users')
      .update({ password_hash: await bcrypt.hash(new_password, 10) })
      .eq('id', req.user.id);

    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function makeToken(user, employeeId) {
  return jwt.sign(
    { id: user.id, email: user.email, roles: user.roles, employee_id: employeeId },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function publicUser(user, emp) {
  return {
    id         : user.id,
    email      : user.email,
    first_name : user.first_name,
    last_name  : user.last_name,
    roles      : user.roles,
    employee_id: emp?.id || null,
  };
}

module.exports = router;
