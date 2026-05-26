'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();
router.use(authenticate);

router.get('/', authorize('hr', 'admin', 'hr_manager'), async (req, res) => {
  try {
    const { search, status, department } = req.query;
    let query = supabase.from('employees')
      .select('*, department:departments(name)')
      .order('last_name', { ascending: true });
    if (status)     query = query.eq('employment_status', status);
    if (department) query = query.eq('department_id', department);
    if (search)     query = query.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,employee_id.ilike.%${search}%`
    );
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, employees: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/me', async (req, res) => {
  try {
    const { data, error } = await supabase.from('employees')
      .select('*, department:departments(name), supervisor:employees!supervisor_id(first_name,last_name)')
      .eq('id', req.user.employee_id).single();
    if (error) throw error;
    res.json({ success: true, employee: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/:id', async (req, res) => {
  const isHR = ['hr','admin','hr_manager'].some(r => (req.user.roles||[]).includes(r));
  if (!isHR && req.user.employee_id !== req.params.id)
    return res.status(403).json({ success: false, message: 'Access denied' });
  try {
    const { data, error } = await supabase.from('employees')
      .select('*, department:departments(name), supervisor:employees!supervisor_id(first_name,last_name)')
      .eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, employee: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/', authorize('hr', 'admin', 'hr_manager'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('employees').insert(req.body).select().single();
    if (error) throw error;
    await supabase.from('activity_logs').insert({
      user_id: req.user.id, action: 'CREATE_EMPLOYEE',
      description: 'Created employee: ' + data.first_name + ' ' + data.last_name
    });
    res.status(201).json({ success: true, employee: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.put('/:id', authorize('hr', 'admin', 'hr_manager'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('employees')
      .update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, employee: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    await supabase.from('employees')
      .update({ employment_status: 'inactive', archived_at: new Date().toISOString() })
      .eq('id', req.params.id);
    res.json({ success: true, message: 'Employee archived' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
