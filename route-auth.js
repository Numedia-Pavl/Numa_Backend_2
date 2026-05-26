'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const supabase = require('./db');
const { authenticate } = require('./authMiddleware');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password required' });
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, password_hash, full_name, roles, employee_id, is_active')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user)
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    if (!user.is_active)
      return res.status(403).json({ success: false, message: 'Account is deactivated. Contact HR.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ success: false, message: 'Invalid email or password' });

    const token = jwt.sign(
      { id: user.id, email: user.email, roles: user.roles, employee_id: user.employee_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await supabase.from('activity_logs').insert({
      user_id: user.id, action: 'LOGIN', description: 'User logged in'
    });

    res.json({
      success: true, token,
      user: { id: user.id, email: user.email, full_name: user.full_name, roles: user.roles, employee_id: user.employee_id }
    });
  } catch (err) {
    console.error('[Auth/login]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, full_name, roles, employee_id, is_active')
      .eq('id', req.user.id)
      .single();
    if (error || !user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ success: false, message: 'Both passwords required' });
  if (new_password.length < 8)
    return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
  try {
    const { data: user } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single();
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 12);
    await supabase.from('users').update({ password_hash: hash }).eq('id', req.user.id);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
