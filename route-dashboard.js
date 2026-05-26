'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();
router.use(authenticate);

router.get('/summary', authorize('hr', 'admin', 'hr_manager', 'payroll_officer'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [
      { count: totalEmployees },
      { count: activeToday },
      { count: pendingLeaves },
      { data: lastPayroll }
    ] = await Promise.all([
      supabase.from('employees').select('*', { count: 'exact', head: true }).eq('employment_status', 'active'),
      supabase.from('attendance').select('*', { count: 'exact', head: true }).eq('date', today).eq('status', 'present'),
      supabase.from('leave_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('payroll_runs').select('period_end, status, pay_date').order('period_end', { ascending: false }).limit(1),
    ]);
    res.json({
      success: true,
      summary: {
        total_employees: totalEmployees || 0,
        present_today:   activeToday    || 0,
        pending_leaves:  pendingLeaves  || 0,
        last_payroll:    lastPayroll?.[0] || null,
      }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
