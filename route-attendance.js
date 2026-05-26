'use strict';
const express  = require('express');
const supabase = require('./db');
const { authenticate, authorize } = require('./authMiddleware');

const router = express.Router();

// ── Philippine timezone helper ─────────────────────────────
function phTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
}
function phDate()    { return phTime().toISOString().split('T')[0]; }
function phTimeStr() { return phTime().toTimeString().split(' ')[0]; }

// ── Compute late minutes & overtime ──────────────────────
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

// ── Biometric key check ───────────────────────────────────
function verifyBiometricKey(req, res) {
  const key = req.headers['x-biometric-key'] || req.query.api_key;
  if (!key || key !== process.env.BIOMETRIC_API_KEY) {
    res.status(401).json({ success:false, message:'Invalid biometric API key' });
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════
// WEB ENDPOINTS (JWT auth)
// ══════════════════════════════════════════════════════════

// GET /api/attendance — list (role-filtered)
router.get('/', authenticate, async (req, res) => {
  try {
    const roles = req.user.roles || [];
    const isHR  = ['hr','admin','hr_manager'].some(r => roles.includes(r));
    const { from, to, employee_id } = req.query;
    let query = supabase.from('attendance')
      .select('*, employee:employees(first_name,last_name,employee_id,position,department:departments(name))')
      .order('date', { ascending: false }).limit(300);
    if (isHR && employee_id) query = query.eq('employee_id', employee_id);
    else if (!isHR)          query = query.eq('employee_id', req.user.employee_id);
    if (from) query = query.gte('date', from);
    if (to)   query = query.lte('date', to);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success:true, records: data });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/attendance/today — current user's today status
router.get('/today', authenticate, async (req, res) => {
  try {
    const today = phDate();
    const { data } = await supabase.from('attendance')
      .select('*').eq('employee_id', req.user.employee_id).eq('date', today).single();
    res.json({ success:true, record: data||null, date:today, server_time:phTimeStr() });
  } catch(e) { res.json({ success:true, record:null, date:phDate(), server_time:phTimeStr() }); }
});

// GET /api/attendance/summary — HR dashboard today summary
router.get('/summary', authenticate, authorize('hr','admin','hr_manager'), async (req, res) => {
  try {
    const today = phDate();
    const { data: recs }       = await supabase.from('attendance').select('status, late_minutes, overtime_minutes, hours_worked, employee:employees(first_name,last_name,employee_id)').eq('date', today);
    const { count: total }     = await supabase.from('employees').select('*',{count:'exact',head:true}).eq('employment_status','active');
    const present  = (recs||[]).filter(r=>r.status==='present').length;
    const late     = (recs||[]).filter(r=>r.status==='late').length;
    const absent   = Math.max(0,(total||0)-(recs||[]).length);
    const totalOT  = (recs||[]).reduce((a,b)=>a+(b.overtime_minutes||0),0);
    res.json({ success:true, summary:{ date:today, total_active:total, present, late, absent, total_ot_minutes:totalOT, records:recs||[] }});
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/attendance/clock-in
router.post('/clock-in', authenticate, async (req, res) => {
  const today = phDate();
  const now   = phTimeStr();
  const { latitude, longitude, notes } = req.body;
  try {
    const { data: existing } = await supabase.from('attendance')
      .select('id,clock_in,clock_out').eq('employee_id', req.user.employee_id).eq('date', today).single();
    if (existing) return res.status(400).json({ success:false, message: existing.clock_out ? 'Shift already completed today' : `Already clocked in at ${existing.clock_in}` });

    const { data: emp } = await supabase.from('employees').select('shift_start,shift_end').eq('id', req.user.employee_id).single();
    const shiftStart = emp?.shift_start||'08:00:00';
    const shiftEnd   = emp?.shift_end  ||'17:00:00';
    const { lateMinutes, status } = computeLateAndOT(now, null, shiftStart, shiftEnd);

    const { data, error } = await supabase.from('attendance').insert({
      employee_id:  req.user.employee_id,
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
  try {
    const { data: record } = await supabase.from('attendance')
      .select('*').eq('employee_id', req.user.employee_id).eq('date', today).single();
    if (!record)        return res.status(404).json({ success:false, message:'No clock-in found for today' });
    if (record.clock_out) return res.status(400).json({ success:false, message:`Already clocked out at ${record.clock_out}` });

    const { overtimeMinutes, hoursWorked } = computeLateAndOT(record.clock_in, now, record.shift_start||'08:00:00', record.shift_end||'17:00:00');
    const { data, error } = await supabase.from('attendance')
      .update({ clock_out:now, overtime_minutes:overtimeMinutes, hours_worked:hoursWorked })
      .eq('id', record.id).select().single();
    if (error) throw error;

    res.json({ success:true, record:data,
      message: overtimeMinutes>0 ? `Clocked out at ${now} — ${overtimeMinutes} min OT` : `Clocked out at ${now} — ${hoursWorked}h worked`,
      hours_worked:hoursWorked, overtime_minutes:overtimeMinutes });
  } catch(err) { res.status(400).json({ success:false, message:err.message }); }
});

// POST /api/attendance/manual — HR manual entry/correction
router.post('/manual', authenticate, authorize('hr','admin','hr_manager'), async (req, res) => {
  try {
    const { employee_id, date, clock_in, clock_out, status, notes, shift_start, shift_end } = req.body;
    if (!employee_id||!date) return res.status(400).json({ success:false, message:'employee_id and date required' });
    const ss = shift_start||'08:00:00', se = shift_end||'17:00:00';
    const comp = clock_in ? computeLateAndOT(clock_in, clock_out, ss, se) : {};
    const { data, error } = await supabase.from('attendance').upsert({
      employee_id, date, clock_in, clock_out,
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

// PUT /api/attendance/:id — HR edit existing record
router.put('/:id', authenticate, authorize('hr','admin','hr_manager'), async (req, res) => {
  try {
    const u = req.body;
    if (u.clock_in && u.clock_out) {
      const c = computeLateAndOT(u.clock_in, u.clock_out, u.shift_start||'08:00:00', u.shift_end||'17:00:00');
      u.late_minutes=c.lateMinutes; u.overtime_minutes=c.overtimeMinutes; u.hours_worked=c.hoursWorked;
      if (!u.status) u.status=c.status;
    }
    const { data, error } = await supabase.from('attendance').update(u).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success:true, record:data });
  } catch(err) { res.status(400).json({ success:false, message:err.message }); }
});

// ══════════════════════════════════════════════════════════
// BIOMETRIC DEVICE API (no JWT — uses BIOMETRIC_API_KEY)
// Compatible with ZKTeco, Anviz, and similar PH devices
// ══════════════════════════════════════════════════════════

// GET /api/attendance/biometric/status — device connectivity test
router.get('/biometric/status', (req, res) => {
  if (!verifyBiometricKey(req,res)) return;
  res.json({ success:true, status:'connected', server:'NUMA HRIS', version:'2.0.0',
    ph_time:phTimeStr(), ph_date:phDate(), timestamp:new Date().toISOString() });
});

// GET /api/attendance/biometric/employees — sync roster to device
router.get('/biometric/employees', async (req, res) => {
  if (!verifyBiometricKey(req,res)) return;
  try {
    const { data, error } = await supabase.from('employees')
      .select('id,employee_id,first_name,last_name,department:departments(name)')
      .eq('employment_status','active').order('employee_id');
    if (error) throw error;
    const employees = (data||[]).map((e,i) => ({
      user_id:      i+1,
      employee_code: e.employee_id,
      name:         `${e.first_name} ${e.last_name}`,
      department:   e.department?.name||'General',
      privilege:    0,
    }));
    res.json({ success:true, count:employees.length, employees });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/attendance/biometric/punch — single punch from device
// punch_type: 0=check-in, 1=check-out, 4=OT-in, 5=OT-out
// verify_type: 1=fingerprint, 2=card, 3=PIN, 15=face
router.post('/biometric/punch', async (req, res) => {
  if (!verifyBiometricKey(req,res)) return;
  const { employee_code, punch_time, punch_type, device_id, verify_type } = req.body;
  if (!employee_code||!punch_time) return res.status(400).json({ success:false, message:'employee_code and punch_time required' });

  try {
    const { data:emp } = await supabase.from('employees')
      .select('id,first_name,last_name,shift_start,shift_end')
      .eq('employee_id', employee_code).eq('employment_status','active').single();
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
        .select('id,clock_in').eq('employee_id',emp.id).eq('date',punchDate).single();
      if (existing) return res.json({ success:true, action:'skipped', message:`Already clocked in at ${existing.clock_in}`, employee:`${emp.first_name} ${emp.last_name}` });

      const { lateMinutes, status } = computeLateAndOT(punchClock, null, shiftStart, shiftEnd);
      const { data } = await supabase.from('attendance').insert({
        employee_id:emp.id, date:punchDate, clock_in:punchClock,
        status, late_minutes:lateMinutes, source:'biometric',
        device_id:device_id||null, verify_type:verifyLabel,
        shift_start:shiftStart, shift_end:shiftEnd,
      }).select().single();

      return res.json({ success:true, action:'clock_in', employee:`${emp.first_name} ${emp.last_name}`,
        time:punchClock, late_minutes:lateMinutes, status, record_id:data?.id });

    } else {
      const { data:record } = await supabase.from('attendance')
        .select('*').eq('employee_id',emp.id).eq('date',punchDate).single();
      if (!record) {
        const { data } = await supabase.from('attendance').insert({
          employee_id:emp.id, date:punchDate, clock_out:punchClock,
          status:'present', source:'biometric', device_id, verify_type:verifyLabel,
        }).select().single();
        return res.json({ success:true, action:'clock_out_no_in', record_id:data?.id });
      }
      if (record.clock_out) return res.json({ success:true, action:'skipped', message:`Already clocked out at ${record.clock_out}` });

      const { overtimeMinutes, hoursWorked } = computeLateAndOT(record.clock_in, punchClock, shiftStart, shiftEnd);
      const { data } = await supabase.from('attendance')
        .update({ clock_out:punchClock, overtime_minutes:overtimeMinutes, hours_worked:hoursWorked })
        .eq('id',record.id).select().single();

      return res.json({ success:true, action:'clock_out', employee:`${emp.first_name} ${emp.last_name}`,
        time:punchClock, hours_worked:hoursWorked, overtime_minutes:overtimeMinutes, record_id:data?.id });
    }
  } catch(err) {
    console.error('[Biometric/punch]', err);
    res.status(500).json({ success:false, message:err.message });
  }
});

// POST /api/attendance/biometric/batch — sync historical logs after offline
router.post('/biometric/batch', async (req, res) => {
  if (!verifyBiometricKey(req,res)) return;
  const { punches, device_id } = req.body;
  if (!Array.isArray(punches)||!punches.length) return res.status(400).json({ success:false, message:'punches array required' });

  const results = { processed:0, skipped:0, errors:[] };
  for (const punch of punches) {
    try {
      const punchDate  = punch.punch_time.split(' ')[0];
      const punchClock = punch.punch_time.split(' ')[1];
      const isIn       = punch.punch_type===0||punch.punch_type===4;
      const { data:emp } = await supabase.from('employees').select('id,shift_start,shift_end').eq('employee_id',punch.employee_code).single();
      if (!emp) { results.errors.push(`Not found: ${punch.employee_code}`); continue; }

      const ss=emp.shift_start||'08:00:00', se=emp.shift_end||'17:00:00';
      if (isIn) {
        const { data:ex } = await supabase.from('attendance').select('id').eq('employee_id',emp.id).eq('date',punchDate).single();
        if (ex) { results.skipped++; continue; }
        const { lateMinutes, status } = computeLateAndOT(punchClock,null,ss,se);
        await supabase.from('attendance').insert({ employee_id:emp.id, date:punchDate, clock_in:punchClock, status, late_minutes:lateMinutes, source:'biometric', device_id:device_id||punch.device_id, shift_start:ss, shift_end:se });
        results.processed++;
      } else {
        const { data:rec } = await supabase.from('attendance').select('*').eq('employee_id',emp.id).eq('date',punchDate).single();
        if (!rec||rec.clock_out) { results.skipped++; continue; }
        const { overtimeMinutes, hoursWorked } = computeLateAndOT(rec.clock_in,punchClock,ss,se);
        await supabase.from('attendance').update({ clock_out:punchClock, overtime_minutes:overtimeMinutes, hours_worked:hoursWorked }).eq('id',rec.id);
        results.processed++;
      }
    } catch(e) { results.errors.push(`${punch.employee_code}: ${e.message}`); }
  }
  res.json({ success:true, results });
});

module.exports = router;
