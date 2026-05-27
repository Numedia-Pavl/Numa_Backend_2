'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();

// ── Slug generator ────────────────────────────────────────────
function toSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

// ══════════════════════════════════════════════════════════════
// POST /api/companies/register
// Public endpoint — creates a new company + first admin account
// Called from the signup page
// ══════════════════════════════════════════════════════════════
router.post('/register', async (req, res) => {
  const {
    company_name, industry, admin_name,
    admin_email, admin_password, plan
  } = req.body;

  if (!company_name || !admin_name || !admin_email || !admin_password) {
    return res.status(400).json({ success: false, message: 'All fields are required' });
  }
  if (admin_password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }

  const slug = toSlug(company_name) + '-' + Math.random().toString(36).slice(2, 6);

  try {
    // Check email not already used
    const { data: existing } = await supabase.from('users')
      .select('id').eq('email', admin_email.toLowerCase().trim()).single();
    if (existing) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists' });
    }

    const password_hash = await bcrypt.hash(admin_password, 12);

    // Call the DB function that creates company + admin + default depts in one transaction
    const { data, error } = await supabase.rpc('register_company', {
      p_company_name:        company_name,
      p_slug:                slug,
      p_plan:                plan || 'business',
      p_admin_name:          admin_name,
      p_admin_email:         admin_email.toLowerCase().trim(),
      p_admin_password_hash: password_hash,
    });

    if (error) throw error;

    res.status(201).json({
      success:    true,
      message:    `${company_name} has been registered! You can now sign in.`,
      company_id: data.company_id,
    });

  } catch (err) {
    console.error('[Companies/register]', err);
    res.status(500).json({ success: false, message: err.message || 'Registration failed' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/companies/me — get current company info
// ══════════════════════════════════════════════════════════════
router.get('/me', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase.from('companies')
      .select('*')
      .eq('id', req.user.company_id)
      .single();
    if (error) throw error;
    res.json({ success: true, company: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/companies/me — update company info (HR/Admin only)
// ══════════════════════════════════════════════════════════════
router.put('/me', authenticate, authorize('admin', 'hr'), async (req, res) => {
  const allowed = ['name','industry','address','phone','email','logo_url'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();
  try {
    const { data, error } = await supabase.from('companies')
      .update(updates).eq('id', req.user.company_id).select().single();
    if (error) throw error;
    res.json({ success: true, company: data });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// SUPER ADMIN — list all companies (protected by SUPER_ADMIN_KEY header)
// Only you (Paulo) can call this, not any client
// ══════════════════════════════════════════════════════════════
router.get('/all', async (req, res) => {
  const key = req.headers['x-super-admin-key'];
  if (!key || key !== process.env.SUPER_ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const { data, error } = await supabase.from('companies')
      .select('id, name, slug, plan, is_active, created_at, max_employees')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Count employees per company
    const counts = await Promise.all(data.map(async c => {
      const { count } = await supabase.from('employees')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', c.id);
      return { ...c, employee_count: count };
    }));
    res.json({ success: true, companies: counts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// SUPER ADMIN — deactivate a company
// ══════════════════════════════════════════════════════════════
router.put('/:id/status', async (req, res) => {
  const key = req.headers['x-super-admin-key'];
  if (!key || key !== process.env.SUPER_ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const { data, error } = await supabase.from('companies')
      .update({ is_active: req.body.is_active }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, company: data });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
