'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();
router.use(authenticate);

// Every query filters by req.user.company_id — isolation guaranteed

router.get('/', async (req, res) => {
  try {
    const { search, status, department } = req.query;
    let query = supabase.from('employees')
      .select('*, department:departments(id,name)')
      .eq('company_id', req.user.company_id)  // ← ISOLATION
      .order('last_name');

    if (search) {
      query = query.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,employee_id.ilike.%${search}%,position.ilike.%${search}%`
      );
    }
    if (status)     query = query.eq('employment_status', status);
    if (department) query = query.eq('department_id', department);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, employees: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('employees')
      .select('*, department:departments(id,name)')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION
      .single();
    if (error) throw error;
    res.json({ success: true, employee: data });
  } catch (err) { res.status(404).json({ success: false, message: 'Employee not found' }); }
});

router.post('/', authorize('admin','hr','hr_manager'), async (req, res) => {
  try {
    const emp = { ...req.body, company_id: req.user.company_id };  // ← TAG WITH COMPANY
    const { data, error } = await supabase.from('employees').insert(emp).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, employee: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

// ── Bulk import ────────────────────────────────────────────────
router.post('/bulk', authorize('admin','hr','hr_manager'), async (req, res) => {
  const { employees } = req.body;
  if (!Array.isArray(employees) || !employees.length) {
    return res.status(400).json({ success: false, message: 'employees array required' });
  }

  const results = { inserted: 0, skipped: 0, errors: [] };
  const tagged  = employees.map(e => ({ ...e, company_id: req.user.company_id }));

  // Process in batches of 20
  const BATCH = 20;
  for (let i = 0; i < tagged.length; i += BATCH) {
    const batch = tagged.slice(i, i + BATCH);
    try {
      const { data, error } = await supabase.from('employees')
        .upsert(batch, { onConflict: 'company_id,email', ignoreDuplicates: false })
        .select();
      if (error) throw error;
      results.inserted += (data || []).length;
    } catch (e) {
      results.errors.push(`Batch ${Math.floor(i/BATCH)+1}: ${e.message}`);
      results.skipped += batch.length;
    }
  }

  res.json({ success: true, results });
});

router.put('/:id', authorize('admin','hr','hr_manager'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('employees')
      .update(req.body)
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION
      .select().single();
    if (error) throw error;
    res.json({ success: true, employee: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.delete('/:id', authorize('admin','hr'), async (req, res) => {
  try {
    await supabase.from('employees')
      .update({ employment_status: 'inactive' })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id);  // ← ISOLATION
    res.json({ success: true, message: 'Employee archived' });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

module.exports = router;
