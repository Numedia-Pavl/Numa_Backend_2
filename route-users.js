'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();
router.use(authenticate);

// ── ISOLATION: every query filters by req.user.company_id ────

router.get('/', authorize('admin','hr','hr_manager'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('users')
      .select('id, email, full_name, roles, is_active, created_at, employee_id, employee:employees(first_name,last_name,employee_id,position)')
      .eq('company_id', req.user.company_id)  // ← ISOLATION: only this company's users
      .order('full_name');
    if (error) throw error;
    res.json({ success: true, users: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/', authorize('admin','hr_manager'), async (req, res) => {
  const { email, password, full_name, roles, employee_id } = req.body;
  if (!email || !password || !full_name)
    return res.status(400).json({ success: false, message: 'email, password, full_name required' });
  if (password.length < 8)
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

  // If linking to an employee, verify that employee belongs to this company
  if (employee_id) {
    const { data: emp } = await supabase.from('employees')
      .select('id')
      .eq('id', employee_id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION: verify employee ownership
      .single();
    if (!emp) return res.status(403).json({ success: false, message: 'Employee not found in your company' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase.from('users').insert({
      email:       email.toLowerCase().trim(),
      password_hash: hash,
      full_name,
      roles:       roles || ['employee'],
      employee_id: employee_id || null,
      company_id:  req.user.company_id,  // ← TAG WITH COMPANY
      is_active:   true,
    }).select('id, email, full_name, roles, is_active').single();
    if (error) throw error;
    res.status(201).json({ success: true, user: data });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Email already exists' });
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/:id', authorize('admin','hr_manager'), async (req, res) => {
  const { roles, is_active, full_name } = req.body;
  try {
    const updates = {};
    if (roles     !== undefined) updates.roles     = roles;
    if (is_active !== undefined) updates.is_active = is_active;
    if (full_name !== undefined) updates.full_name = full_name;

    const { data, error } = await supabase.from('users')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION: can only edit own company's users
      .select('id, email, full_name, roles, is_active').single();
    if (error) throw error;
    res.json({ success: true, user: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.put('/:id/reset-password', authorize('admin'), async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 8)
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  try {
    // Verify the user being reset belongs to this company
    const { data: targetUser } = await supabase.from('users')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION: can't reset other company's passwords
      .single();
    if (!targetUser) return res.status(403).json({ success: false, message: 'User not found in your company' });

    const hash = await bcrypt.hash(new_password, 12);
    await supabase.from('users').update({ password_hash: hash }).eq('id', req.params.id);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
