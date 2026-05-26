'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const roles = req.user.roles || [];
    const isHR  = ['hr','admin','hr_manager'].some(r => roles.includes(r));
    const { from, to, employee_id } = req.query;
    let query = supabase.from('attendance')
      .select('*, employee:employees(first_name,last_name,employee_id)')
      .order('date', { ascending: false }).limit(500);
    if (isHR && employee_id) query = query.eq('employee_id', employee_id);
    else if (!isHR)          query = query.eq('employee_id', req.user.employee_id);
    if (from) query = query.gte('date', from);
    if (to)   query = query.lte('date', to);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, records: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/clock-in', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data: existing } = await supabase.from('attendance')
      .select('id').eq('employee_id', req.user.employee_id).eq('date', today).single();
    if (existing) return res.status(400).json({ success: false, message: 'Already clocked in today' });
    const clockIn = new Date().toTimeString().split(' ')[0];
    const { data, error } = await supabase.from('attendance')
      .insert({ employee_id: req.user.employee_id, date: today, clock_in: clockIn, status: 'present' })
      .select().single();
    if (error) throw error;
    res.json({ success: true, record: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.put('/clock-out', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data: record } = await supabase.from('attendance')
      .select('*').eq('employee_id', req.user.employee_id).eq('date', today).single();
    if (!record) return res.status(404).json({ success: false, message: 'No clock-in found for today' });
    if (record.clock_out) return res.status(400).json({ success: false, message: 'Already clocked out today' });
    const clockOut = new Date().toTimeString().split(' ')[0];
    const { data, error } = await supabase.from('attendance')
      .update({ clock_out: clockOut }).eq('id', record.id).select().single();
    if (error) throw error;
    res.json({ success: true, record: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.post('/', authorize('hr', 'admin', 'hr_manager'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('attendance').insert(req.body).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, record: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

module.exports = router;
