'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();

function phTime()    { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })); }
function phDate()    { return phTime().toISOString().split('T')[0]; }
function phTimeStr() { return phTime().toTimeString().split(' ')[0]; }

function computeLateAndOT(clockIn, clockOut, shiftStart='08:00:00', shiftEnd='17:00:00') {
  const toMins = t => { const [h,m] = (t||'00:00').split(':').map(Number); return h*60+m; };
  const inMins    = toMins(clockIn);
  const outMins   = clockOut ? toMins(clockOut) : null;
  const startMins = toMins(shiftStart);
  const endMins   = toMins(shiftEnd);
  const lateMinutes     = Math.max(0, inMins - startMins);
  const overtimeMinutes = outMins ? Math.max(0, outMins - endMins) : 0;
  const hoursWorked     = outMins ? Math.round((outMins - inMins)/60*100)/100 : null;
  const status = lateMinutes >= 30 ? 'late' : 'present';
  return { lateMinutes, overtimeMinutes, hoursWorked, status };
}

function verifyBiometricKey(req, res) {
  const key = req.headers['x-biometric-key'] || req.query.api_key;
  if (!key || key !== process.env.BIOMETRIC_API_KEY) {
    res.status(401).json({ success:false, message:'Invalid biometric API key' });
    return false;
  }
  return true;
}

// ── ISOLATION: every query filters by req.user.company_id ────

// GET /api/attendance — list (role-filtered + company-isolated)
router.get('/', authenticate, async (req, res) => {
  try {
    const cid   = req.user.company_id;
    const roles = req.user.roles || [];
    const isHR  = ['hr','admin','hr_manager'].some(r => roles.includes(r));
    const { from, to, employee_id } = req.query;

    let query = supabase.from('attendance')
      .select('*, employee:employees(first_name,last_name,employee_id,position,department:departments(name))')
      .eq('company_id', cid)            // ← ISOLATION
      .order('date', { ascending: false })
      .limit(300);

    if (isHR && employee_id) query = query.eq('employee_id', employee_id);
    else if (!isHR)          query = query.eq('employee_id', req.user.employee_id);
    if (from) query = query.gte('date', from);
    if (to)   query = query.lte('date', to);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success:true, records: data });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/attendance/today
router.get('/today', authenticate, async (req, res) => {
  try {
    const { data } = await supabase.from('attendance')
      .select('*')
      .eq('employee_id', req.user.employee_id)
      .eq('company_id',  req.user.company_id)  // ← ISOLATION
      .eq('date', phDate())
      .single();
    res.json({ success:true, record:data||null, date:phDate(), server_time:phTimeStr() });
  } catch(e) { res.json({ success:true, record:null, date:phDate(), server_time:phTimeStr() }); }
});

// GET /api/attendance/summary — HR only
router.get('/summary', authenticate, authorize('hr','admin','hr_manager'), async (req, res) => {
  try {
    const cid = req.user.company_id;
    const today = phDate();
    const { data: recs }   = await supabase.from('attendance')
      .select('status,late_minutes,overtime_minutes,employee:employees(first_name,last_name,employee_id)')
      .eq('company_id', cid)            // ← ISOLATION
      .eq('date', today);
    const { count: total } = await supabase.from('employees')
      .select('*',{count:'exact',head:true})
      .eq('company_id', cid)            // ← ISOLATION
      .eq('employment_status','active');
    const present = (recs||[]).filter(r=>r.status==='present').length;
    const late    = (recs||[]).filter(r=>r.status==='late').length;
    const absent  = Math.max(0,(total||0)-(recs||[]).length);
    res.json({ success:true, summary:{ date:today, total_active:total, present, late, absent, records:recs||[] }});
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/attendance/clock-in
router.post('/clock-in', authenticate, async (req, res) => {
  const today = phDate();
  const now   = phTimeStr();
  const cid   = req.user.company_id;
  const { latitude, longitude, notes } = req.body;
  try {
    const { data: existing } = await supabase.from('attendance')
      .select('id,clock_in,clock_out')
      .eq('employee_id', req.user.employee_id)
      .eq('company_id',  cid)           // ← ISOLATION
      .eq('date', today).single();
    if (existing) return res.status(400).json({ success:false,
      message: existing.clock_out ? 'Shift already completed today' : `Already clocked in at ${existing.clock_in}` });

    const { data: emp } = await supabase.from('employees')
      .select('shift_start,shift_end')
      .eq('id', req.user.employee_id)
      .eq('company_id', cid)            // ← ISOLATION
      .single();
    const shiftStart = emp?.shift_start||'08:00:00';
    const shiftEnd   = emp?.shift_end  ||'17:00:00';
    const { lateMinutes, status } = computeLateAndOT(now, null, shiftStart, shiftEnd);

    const { data, error } = await supabase.from('attendance').insert({
      employee_id:  req.user.employee_id,
      company_id:   cid,                // ← TAG WITH COMPANY
      date:today, clock_in:now, status, late_minutes:lateMinutes,
      source:'web', latitude:latitude||null, longitude:longitude||null,
      notes:notes||null, shift_start:shiftStart, shift_end:shiftEnd,
    }).select().single();
    if (error) throw error;

    res.json({ success:true, record:data,
      message: lateMinutes>0 ? `Clocked in at ${now} — ${lateMinutes} min late` : `Clocked in at ${now} — on time ✓`,
      late_minutes:lateMinutes });
  } catch(err) { res.status(400).json({ success:false, message:err.message }); }
});

// PUT /api/attendance/clock-out
router.put('/clock-out', authenticate, async (req, res) => {
  const today = phDate();
  const now   = phTimeStr();
  const cid   = req.user.company_id;
  try {
    const { data: record } = await supabase.from('attendance')
      .select('*')
      .eq('employee_id', req.user.employee_id)
      .eq('company_id',  cid)           // ← ISOLATION
      .eq('date', today).single();
    if (!record)        return res.status(404).json({ success:false, message:'No clock-in found for today' });
    if (record.clock_out) return res.status(400).json({ success:false, message:`Already clocked out at ${record.clock_out}` });

    const { overtimeMinutes, hoursWorked } = computeLateAndOT(record.clock_in, now, record.shift_start||'08:00:00', record.shift_end||'17:00:00');
    const { data, error } = await supabase.from('attendance')
      .update({ clock_out:now, overtime_minutes:overtimeMinutes, hours_worked:hoursWorked })
      .eq('id', record.id)
      .eq('company_id', cid)            // ← ISOLATION
      .select().single();
    if (error) throw error;

    res.json({ success:true, record:data,
      message: overtimeMinutes>0 ? `Clocked out at ${now} — ${overtimeMinutes} min OT` : `Clocked out at ${now} — ${hoursWorked}h worked`,
      hours_worked:hoursWorked, overtime_minutes:overtimeMinutes });
  } catch(err) { res.status(400).json({ success:false, message:err.message }); }
});

// POST /api/attendance/manual — HR manual entry
router.post('/manual', authenticate, authorize('hr','admin','hr_manager'), async (req, res) => {
  try {
    const { employee_id, date, clock_in, clock_out, status, notes, shift_start, shift_end } = req.body;
    if (!employee_id||!date) return res.status(400).json({ success:false, message:'employee_id and date required' });

    // Verify employee belongs to this company
    const { data: emp } = await supabase.from('employees')
      .select('id').eq('id', employee_id).eq('company_id', req.user.company_id).single();
    if (!emp) return res.status(403).json({ success:false, message:'Employee not found in your company' });

    const ss=shift_start||'08:00:00', se=shift_end||'17:00:00';
    const comp = clock_in ? computeLateAndOT(clock_in, clock_out, ss, se) : {};
    const { data, error } = await supabase.from('attendance').upsert({
      employee_id, date,
      company_id:       req.user.company_id,  // ← TAG WITH COMPANY
      clock_in, clock_out,
      status:           status||comp.status||'present',
      late_minutes:     comp.lateMinutes||0,
      overtime_minutes: comp.overtimeMinutes||0,
      hours_worked:     comp.hoursWorked||null,
      source:'manual', shift_start:ss, shift_end:se, notes,
    },{ onConflict:'employee_id,date' }).select().single();
    if (error) throw error;
    res.status(201).json({ success:true, record:data });
  } catch(err) { res.status(400).json({ success:false, message:err.message }); }
});

// PUT /api/attendance/:id — HR edit
router.put('/:id', authenticate, authorize('hr','admin','hr_manager'), async (req, res) => {
  try {
    const u = req.body;
    if (u.clock_in && u.clock_out) {
      const c = computeLateAndOT(u.clock_in, u.clock_out, u.shift_start||'08:00:00', u.shift_end||'17:00:00');
      u.late_minutes=c.lateMinutes; u.overtime_minutes=c.overtimeMinutes; u.hours_worked=c.hoursWorked;
      if (!u.status) u.status=c.status;
    }
    const { data, error } = await supabase.from('attendance')
      .update(u)
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)  // ← ISOLATION: can only edit own company's records
      .select().single();
    if (error) throw error;
    res.json({ success:true, record:data });
  } catch(err) { res.status(400).json({ success:false, message:err.message }); }
});

// ══════════════════════════════════════════════════════════════
// BIOMETRIC DEVICE API
// Uses BIOMETRIC_API_KEY header — no JWT
// Device must also send company_id so records are tagged correctly
// ══════════════════════════════════════════════════════════════

router.get('/biometric/status', (req, res) => {
  if (!verifyBiometricKey(req,res)) return;
  res.json({ success:true, status:'connected', server:'NUMA HRIS', version:'2.1.0',
    ph_time:phTimeStr(), ph_date:phDate(), timestamp:new Date().toISOString() });
});

router.get('/biometric/employees', async (req, res) => {
  if (!verifyBiometricKey(req,res)) return;
  const company_id = req.query.company_id;
  if (!company_id) return res.status(400).json({ success:false, message:'company_id query param required' });
  try {
    const { data, error } = await supabase.from('employees')
      .select('id,employee_id,first_name,last_name,department:departments(name)')
      .eq('company_id', company_id)     // ← ISOLATION: device only gets its company's roster
      .eq('employment_status','active')
      .order('employee_id');
    if (error) throw error;
    const employees = (data||[]).map((e,i) => ({
      user_id: i+1, employee_code:e.employee_id,
      name:`${e.first_name} ${e.last_name}`, department:e.department?.name||'General', privilege:0,
    }));
    res.json({ success:true, count:employees.length, employees });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

router.post('/biometric/punch', async (req, res) => {
  if (!verifyBiometricKey(req,res)) return;
  const { employee_code, punch_time, punch_type, device_id, verify_type, company_id } = req.body;
  if (!employee_code||!punch_time||!company_id)
    return res.status(400).json({ success:false, message:'employee_code, punch_time, and company_id required' });

  try {
    const { data:emp } = await supabase.from('employees')
      .select('id,first_name,last_name,shift_start,shift_end')
      .eq('employee_id', employee_code)
      .eq('company_id', company_id)     // ← ISOLATION: verify employee belongs to this company
      .eq('employment_status','active').single();
    if (!emp) return res.status(404).json({ success:false, message:`Employee not found: ${employee_code}` });

    const punchDate  = punch_time.split(' ')[0];
    const punchClock = punch_time.split(' ')[1]||punch_time;
    const isIn       = punch_type===0||punch_type===4;
    const shiftStart = emp.shift_start||'08:00:00';
    const shiftEnd   = emp.shift_end  ||'17:00:00';
    const verifyMap  = {1:'fingerprint',2:'card',3:'pin',15:'face',0:'unknown'};
    const verifyLabel = verifyMap[verify_type]||'biometric';

    if (isIn) {
      const { data:existing } = await supabase.from('attendance')
        .select('id,clock_in')
        .eq('employee_id',emp.id)
        .eq('company_id', company_id)   // ← ISOLATION
        .eq('date',punchDate).single();
      if (existing) return res.json({ success:true, action:'skipped', message:`Already clocked in at ${existing.clock_in}` });

      const { lateMinutes, status } = computeLateAndOT(punchClock, null, shiftStart, shiftEnd);
      const { data } = await supabase.from('attendance').insert({
        employee_id:emp.id, date:punchDate, clock_in:punchClock,
        company_id,                      // ← TAG WITH COMPANY
        status, late_minutes:lateMinutes, source:'biometric',
        device_id:device_id||null, verify_type:verifyLabel,
        shift_start:shiftStart, shift_end:shiftEnd,
      }).select().single();

      return res.json({ success:true, action:'clock_in', employee:`${emp.first_name} ${emp.last_name}`,
        time:punchClock, late_minutes:lateMinutes, status, record_id:data?.id });
    } else {
      const { data:record } = await supabase.from('attendance')
        .select('*')
        .eq('employee_id',emp.id)
        .eq('company_id', company_id)   // ← ISOLATION
        .eq('date',punchDate).single();
      if (!record||record.clock_out) return res.json({ success:true, action:'skipped' });

      const { overtimeMinutes, hoursWorked } = computeLateAndOT(record.clock_in, punchClock, shiftStart, shiftEnd);
      const { data } = await supabase.from('attendance')
        .update({ clock_out:punchClock, overtime_minutes:overtimeMinutes, hours_worked:hoursWorked })
        .eq('id',record.id)
        .eq('company_id', company_id)   // ← ISOLATION
        .select().single();

      return res.json({ success:true, action:'clock_out', employee:`${emp.first_name} ${emp.last_name}`,
        time:punchClock, hours_worked:hoursWorked, overtime_minutes:overtimeMinutes, record_id:data?.id });
    }
  } catch(err) {
    console.error('[Biometric/punch]', err);
    res.status(500).json({ success:false, message:err.message });
  }
});

router.post('/biometric/batch', async (req, res) => {
  if (!verifyBiometricKey(req,res)) return;
  const { punches, device_id, company_id } = req.body;
  if (!Array.isArray(punches)||!punches.length||!company_id)
    return res.status(400).json({ success:false, message:'punches array and company_id required' });

  const results = { processed:0, skipped:0, errors:[] };
  for (const punch of punches) {
    try {
      const punchDate  = punch.punch_time.split(' ')[0];
      const punchClock = punch.punch_time.split(' ')[1];
      const isIn       = punch.punch_type===0||punch.punch_type===4;
      const { data:emp } = await supabase.from('employees')
        .select('id,shift_start,shift_end')
        .eq('employee_id', punch.employee_code)
        .eq('company_id', company_id)   // ← ISOLATION
        .single();
      if (!emp) { results.errors.push(`Not found: ${punch.employee_code}`); continue; }

      const ss=emp.shift_start||'08:00:00', se=emp.shift_end||'17:00:00';
      if (isIn) {
        const { data:ex } = await supabase.from('attendance')
          .select('id').eq('employee_id',emp.id).eq('company_id',company_id).eq('date',punchDate).single();
        if (ex) { results.skipped++; continue; }
        const { lateMinutes, status } = computeLateAndOT(punchClock,null,ss,se);
        await supabase.from('attendance').insert({
          employee_id:emp.id, date:punchDate, clock_in:punchClock,
          company_id,                    // ← TAG WITH COMPANY
          status, late_minutes:lateMinutes, source:'biometric',
          device_id:device_id||punch.device_id, shift_start:ss, shift_end:se,
        });
        results.processed++;
      } else {
        const { data:rec } = await supabase.from('attendance')
          .select('*').eq('employee_id',emp.id).eq('company_id',company_id).eq('date',punchDate).single();
        if (!rec||rec.clock_out) { results.skipped++; continue; }
        const { overtimeMinutes, hoursWorked } = computeLateAndOT(rec.clock_in,punchClock,ss,se);
        await supabase.from('attendance')
          .update({ clock_out:punchClock, overtime_minutes:overtimeMinutes, hours_worked:hoursWorked })
          .eq('id',rec.id).eq('company_id',company_id);
        results.processed++;
      }
    } catch(e) { results.errors.push(`${punch.employee_code}: ${e.message}`); }
  }
  res.json({ success:true, results });
});

module.exports = router;

