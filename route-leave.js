'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();
router.use(authenticate);

// ── ISOLATION: every query filters by req.user.company_id ────

router.get('/', async (req, res) => {
  try {
    const roles = req.user.roles || [];
    const isHR  = ['hr','admin','hr_manager'].some(r => roles.includes(r));
    const isMgr = roles.includes('manager') || roles.includes('supervisor');
    const cid   = req.user.company_id;  // ← company isolation

    let query = supabase.from('leave_requests')
      .select('*, employee:employees(first_name,last_name,employee_id,position,department:departments(name))')
      .eq('company_id', cid)            // ← ISOLATION: only this company's leaves
      .order('created_at', { ascending: false });

    if (isHR) {
      // HR sees all leaves within their company — nothing else
    } else if (isMgr) {
      // Supervisor sees only their direct reports within the same company
      const { data: directs } = await supabase.from('employees')
        .select('id')
        .eq('supervisor_id', req.user.employee_id)
        .eq('company_id', cid);         // ← ISOLATION: directs must be same company
      const ids = (directs || []).map(d => d.id);
      ids.push(req.user.employee_id);
      query = query.in('employee_id', ids);
    } else {
      // Employee sees only their own
      query = query.eq('employee_id', req.user.employee_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, leave_requests: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/balance', async (req, res) => {
  try {
    const { data } = await supabase.from('leave_balances')
      .select('*')
      .eq('employee_id', req.user.employee_id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION
      .single();
    res.json({ success: true, balance: data || { sick_leave: 15, vacation_leave: 15, emergency_leave: 3 } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/', async (req, res) => {
  const { leave_type, start_date, end_date, reason } = req.body;
  if (!leave_type || !start_date || !end_date)
    return res.status(400).json({ success: false, message: 'leave_type, start_date, end_date required' });
  try {
    const { data, error } = await supabase.from('leave_requests')
      .insert({
        employee_id: req.user.employee_id,
        company_id:  req.user.company_id,  // ← TAG WITH COMPANY
        leave_type, start_date, end_date, reason, status: 'pending'
      }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, leave_request: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.put('/:id/approve', authorize('hr','admin','hr_manager','manager','supervisor'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('leave_requests')
      .update({ status:'approved', remarks:req.body.remarks, approved_by:req.user.id, approved_at:new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION: can only approve own company's leaves
      .select().single();
    if (error) throw error;
    res.json({ success: true, leave_request: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/:id/reject', authorize('hr','admin','hr_manager','manager','supervisor'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('leave_requests')
      .update({ status:'rejected', remarks:req.body.remarks, approved_by:req.user.id, approved_at:new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION
      .select().single();
    if (error) throw error;
    res.json({ success: true, leave_request: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
