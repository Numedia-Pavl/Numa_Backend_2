'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');
const { computePayroll } = require('./payrollUtil');

const router = express.Router();
router.use(authenticate);

// ── Role helpers ──────────────────────────────────────────────
function isFinance(req) {
  const roles = req.user.roles || [];
  return roles.some(r => ['admin','finance','finance_manager','accountant','payroll_officer'].includes(r));
}
function isHR(req) {
  const roles = req.user.roles || [];
  return roles.some(r => ['admin','hr','hr_manager'].includes(r));
}

// ══════════════════════════════════════════════════════════════
// PAYROLL RUNS
// ══════════════════════════════════════════════════════════════

// GET /api/payroll/runs — list all runs for this company
router.get('/runs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payroll_runs_detail')
      .select('*')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false })
      .limit(24);
    if (error) throw error;
    res.json({ success: true, runs: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/payroll/runs — create a new payroll run
router.post('/runs', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ success: false, message: 'HR role required' });
  const { period_start, period_end, pay_date, notes } = req.body;
  if (!period_start || !period_end || !pay_date)
    return res.status(400).json({ success: false, message: 'period_start, period_end, pay_date required' });
  try {
    const { data, error } = await supabase.from('payroll_runs').insert({
      company_id: req.user.company_id,
      period_start, period_end, pay_date, notes,
      status: 'draft',
      created_by: req.user.id,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, run: data });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// PAYROLL APPROVAL WORKFLOW
// ══════════════════════════════════════════════════════════════

// POST /api/payroll/runs/:id/submit
// HR submits payroll for Finance review — locks entries
router.post('/runs/:id/submit', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ success: false, message: 'HR role required to submit' });
  try {
    // Verify this run belongs to this company
    const { data: run } = await supabase.from('payroll_runs')
      .select('*').eq('id', req.params.id).eq('company_id', req.user.company_id).single();
    if (!run) return res.status(404).json({ success: false, message: 'Payroll run not found' });
    if (run.status !== 'draft')
      return res.status(400).json({ success: false, message: `Cannot submit — current status is "${run.status}"` });

    // Get records for this run to calculate totals
    const { data: records } = await supabase.from('payroll_records')
      .select('gross_pay, net_pay').eq('payroll_run_id', req.params.id);
    const total_gross    = (records||[]).reduce((s,r) => s + (r.gross_pay||0), 0);
    const total_net      = (records||[]).reduce((s,r) => s + (r.net_pay||0), 0);
    const employee_count = (records||[]).length;

    if (employee_count === 0)
      return res.status(400).json({ success: false, message: 'No payroll entries found. Add employee entries before submitting.' });

    // Update run status + lock all records
    const { data, error } = await supabase.from('payroll_runs')
      .update({
        status:        'submitted',
        submitted_by:  req.user.id,
        submitted_at:  new Date().toISOString(),
        total_gross, total_net, employee_count,
      })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select().single();
    if (error) throw error;

    // Lock all payroll records so HR can't edit after submission
    await supabase.from('payroll_records')
      .update({ is_locked: true })
      .eq('payroll_run_id', req.params.id);

    // Log activity
    await supabase.from('activity_logs').insert({
      company_id:  req.user.company_id,
      user_id:     req.user.id,
      action:      'PAYROLL_SUBMITTED',
      description: `Payroll submitted for review: ${run.period_start} to ${run.period_end}. ${employee_count} employees, Net: ₱${total_net.toLocaleString()}`,
    });

    res.json({
      success: true,
      run: data,
      message: `Payroll submitted for Finance review. ${employee_count} entries locked pending approval.`,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/payroll/runs/:id/approve
// Finance Manager / Accountant approves — unlocks Release button
router.post('/runs/:id/approve', async (req, res) => {
  if (!isFinance(req)) return res.status(403).json({ success: false, message: 'Finance Manager or Accountant role required to approve' });
  try {
    const { data: run } = await supabase.from('payroll_runs')
      .select('*').eq('id', req.params.id).eq('company_id', req.user.company_id).single();
    if (!run) return res.status(404).json({ success: false, message: 'Payroll run not found' });
    if (run.status !== 'submitted')
      return res.status(400).json({ success: false, message: `Cannot approve — current status is "${run.status}". Must be submitted first.` });

    const { data, error } = await supabase.from('payroll_runs')
      .update({
        status:      'approved',
        approved_by: req.user.id,
        approved_at: new Date().toISOString(),
        notes:       req.body.notes || run.notes,
      })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select().single();
    if (error) throw error;

    await supabase.from('activity_logs').insert({
      company_id:  req.user.company_id,
      user_id:     req.user.id,
      action:      'PAYROLL_APPROVED',
      description: `Payroll approved by ${req.user.full_name||req.user.email}: ${run.period_start} to ${run.period_end}`,
    });

    res.json({
      success: true,
      run: data,
      message: 'Payroll approved. HR can now release payroll to employees.',
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/payroll/runs/:id/reject
// Finance rejects — sends back to draft for HR to correct
router.post('/runs/:id/reject', async (req, res) => {
  if (!isFinance(req)) return res.status(403).json({ success: false, message: 'Finance role required' });
  try {
    const { data: run } = await supabase.from('payroll_runs')
      .select('*').eq('id', req.params.id).eq('company_id', req.user.company_id).single();
    if (!run) return res.status(404).json({ success: false, message: 'Not found' });
    if (run.status !== 'submitted')
      return res.status(400).json({ success: false, message: 'Can only reject submitted payroll' });

    const { data, error } = await supabase.from('payroll_runs')
      .update({ status: 'draft', notes: req.body.reason || 'Rejected by Finance — please review and resubmit' })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select().single();
    if (error) throw error;

    // Unlock records so HR can edit
    await supabase.from('payroll_records')
      .update({ is_locked: false })
      .eq('payroll_run_id', req.params.id);

    await supabase.from('activity_logs').insert({
      company_id:  req.user.company_id,
      user_id:     req.user.id,
      action:      'PAYROLL_REJECTED',
      description: `Payroll rejected by ${req.user.full_name||req.user.email}. Reason: ${req.body.reason||'Not specified'}`,
    });

    res.json({ success: true, run: data, message: 'Payroll rejected and returned to HR for corrections.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/payroll/runs/:id/release
// HR releases payroll after Finance approval — payslips visible to employees
router.post('/runs/:id/release', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ success: false, message: 'HR role required to release' });
  try {
    const { data: run } = await supabase.from('payroll_runs')
      .select('*').eq('id', req.params.id).eq('company_id', req.user.company_id).single();
    if (!run) return res.status(404).json({ success: false, message: 'Not found' });
    if (run.status !== 'approved')
      return res.status(400).json({ success: false, message: 'Payroll must be approved by Finance before release.' });

    const { data, error } = await supabase.from('payroll_runs')
      .update({
        status:      'released',
        released_by: req.user.id,
        released_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select().single();
    if (error) throw error;

    await supabase.from('activity_logs').insert({
      company_id:  req.user.company_id,
      user_id:     req.user.id,
      action:      'PAYROLL_RELEASED',
      description: `Payroll released: ${run.period_start} to ${run.period_end}. ₱${run.total_net?.toLocaleString()} disbursed to ${run.employee_count} employees.`,
    });

    res.json({
      success: true,
      run: data,
      message: `Payroll released! ₱${run.total_net?.toLocaleString()} disbursed to ${run.employee_count} employees.`,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/payroll/runs/:id/records — get all entries for a run
router.get('/runs/:id/records', async (req, res) => {
  try {
    const { data, error } = await supabase.from('payroll_records')
      .select('*, employee:employees(first_name,last_name,employee_id,position,department:departments(name))')
      .eq('payroll_run_id', req.params.id)
      .eq('company_id', req.user.company_id);
    if (error) throw error;
    res.json({ success: true, records: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/payroll/pending-approval — Finance dashboard: runs awaiting approval
router.get('/pending-approval', async (req, res) => {
  if (!isFinance(req)) return res.status(403).json({ success: false, message: 'Finance role required' });
  try {
    const { data, error } = await supabase.from('payroll_runs_detail')
      .select('*')
      .eq('company_id', req.user.company_id)
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, runs: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/payroll/my-payslips — employee's own payslips (released only)
router.get('/my-payslips', async (req, res) => {
  try {
    const { data, error } = await supabase.from('payroll_records')
      .select('*, run:payroll_runs(period_start,period_end,pay_date,status)')
      .eq('employee_id', req.user.employee_id)
      .eq('company_id',  req.user.company_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    // Only show released payslips to employees
    const roles = req.user.roles || [];
    const isAdminOrHR = roles.some(r => ['admin','hr','hr_manager','finance'].includes(r));
    const filtered = isAdminOrHR ? data : (data||[]).filter(r => r.run?.status === 'released');
    res.json({ success: true, payslips: filtered });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/payroll/compute — server-side computation
router.post('/compute', async (req, res) => {
  const { basic_pay, allowances, overtime_pay, other_deductions } = req.body;
  if (!basic_pay) return res.status(400).json({ success: false, message: 'basic_pay required' });
  try {
    const result = computePayroll({
      basicPay:        Number(basic_pay),
      allowances:      Number(allowances       || 0),
      overtimePay:     Number(overtime_pay     || 0),
      otherDeductions: Number(other_deductions || 0),
    });
    res.json({ success: true, computation: result });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

module.exports = router;
