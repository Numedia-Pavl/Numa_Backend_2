'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');
const { computePayroll } = require('./payrollUtil');

const router = express.Router();
router.use(authenticate);

// ── ISOLATION: every query filters by req.user.company_id ────

router.get('/', authorize('hr','admin','hr_manager','payroll_officer'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('payroll_runs')
      .select('*')
      .eq('company_id', req.user.company_id)  // ← ISOLATION
      .order('period_end', { ascending: false })
      .limit(24);
    if (error) throw error;
    res.json({ success: true, payroll_runs: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/my-payslips', async (req, res) => {
  try {
    const { data, error } = await supabase.from('payroll_records')
      .select('*, payroll_run:payroll_runs(period_start,period_end,pay_date,status)')
      .eq('employee_id', req.user.employee_id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION: own payslips only
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, payslips: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/compute', authorize('hr','admin','hr_manager','payroll_officer'), async (req, res) => {
  const { basic_pay, allowances, overtime_pay, days_absent, lates_minutes, working_days } = req.body;
  if (!basic_pay) return res.status(400).json({ success: false, message: 'basic_pay required' });
  try {
    const result = computePayroll({
      basicPay:     Number(basic_pay),
      allowances:   Number(allowances    || 0),
      overtimePay:  Number(overtime_pay  || 0),
      daysAbsent:   Number(days_absent   || 0),
      latesMinutes: Number(lates_minutes || 0),
      workingDays:  Number(working_days  || 22),
    });
    res.json({ success: true, computation: result });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.post('/run', authorize('hr','admin','hr_manager','payroll_officer'), async (req, res) => {
  const { period_start, period_end, pay_date } = req.body;
  if (!period_start || !period_end || !pay_date)
    return res.status(400).json({ success: false, message: 'period_start, period_end, pay_date required' });

  const cid = req.user.company_id;  // ← company isolation

  try {
    const { data: run, error: runErr } = await supabase.from('payroll_runs')
      .insert({
        period_start, period_end, pay_date,
        company_id: cid,            // ← TAG WITH COMPANY
        status: 'processing',
        created_by: req.user.id
      }).select().single();
    if (runErr) throw runErr;

    // Only process THIS company's active employees
    const { data: employees } = await supabase.from('employees')
      .select('id, basic_pay, allowances')
      .eq('company_id', cid)        // ← ISOLATION
      .eq('employment_status', 'active');

    // Only pull THIS company's attendance data
    const { data: attendance } = await supabase.from('attendance')
      .select('employee_id, days_absent, late_minutes, overtime_minutes')
      .eq('company_id', cid)        // ← ISOLATION
      .gte('date', period_start)
      .lte('date', period_end);

    const attMap = {};
    (attendance || []).forEach(a => {
      if (!attMap[a.employee_id]) attMap[a.employee_id] = { days_absent:0, late_minutes:0, overtime_minutes:0 };
      attMap[a.employee_id].days_absent      += (a.days_absent      || 0);
      attMap[a.employee_id].late_minutes     += (a.late_minutes     || 0);
      attMap[a.employee_id].overtime_minutes += (a.overtime_minutes || 0);
    });

    const records = (employees || []).map(emp => {
      const att = attMap[emp.id] || {};
      const hourlyRate  = (emp.basic_pay / 22) / 8;
      const overtimePay = (att.overtime_minutes || 0) / 60 * hourlyRate * 1.25;
      const result = computePayroll({
        basicPay:     emp.basic_pay,
        allowances:   emp.allowances || 0,
        overtimePay,
        daysAbsent:   att.days_absent  || 0,
        latesMinutes: att.late_minutes || 0,
      });
      return {
        payroll_run_id:  run.id,
        employee_id:     emp.id,
        company_id:      cid,       // ← TAG WITH COMPANY
        basic_pay:       emp.basic_pay,
        gross_pay:       result.grossPay,
        sss_ee:          result.contributions.sss.employee,
        sss_er:          result.contributions.sss.employer,
        philhealth_ee:   result.contributions.philhealth.employee,
        philhealth_er:   result.contributions.philhealth.employer,
        pagibig_ee:      result.contributions.pagibig.employee,
        pagibig_er:      result.contributions.pagibig.employer,
        withholding_tax: result.withholdingTax,
        total_deductions:result.totalDeductions,
        net_pay:         result.netPay,
        computation_details: result,
      };
    });

    if (records.length > 0) await supabase.from('payroll_records').insert(records);
    await supabase.from('payroll_runs').update({ status:'completed' }).eq('id', run.id);

    res.json({ success:true, message:'Payroll processed', run_id:run.id, count:records.length });
  } catch (err) {
    console.error('[Payroll/run]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:run_id/records', authorize('hr','admin','hr_manager','payroll_officer'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('payroll_records')
      .select('*, employee:employees(first_name,last_name,employee_id,position)')
      .eq('payroll_run_id', req.params.run_id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION
    if (error) throw error;
    res.json({ success: true, records: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
