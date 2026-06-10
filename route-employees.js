const express   = require('express');
const multer    = require('multer');
const { parse } = require('csv-parse/sync');
const router    = express.Router();
const { supabase } = require('./supabase');
const auth      = require('./authMiddleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// ─── HELPER: only HR/Admin can call most routes ───────────────
const hrOnly = [auth.verify, auth.requireRole(['admin','hr','hr_manager'])];

// ─── GET /api/employees ───────────────────────────────────────
router.get('/', auth.verify, async (req, res) => {
  try {
    const { status, department, search, page = 1, limit = 50 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;

    let q = supabase
      .from('employees')
      .select('*', { count: 'exact' })
      .order('last_name', { ascending: true })
      .range(from, to);

    if (status)     q = q.eq('employment_status', status);
    if (department) q = q.eq('department', department);
    if (search)     q = q.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,` +
      `email.ilike.%${search}%,employee_id.ilike.%${search}%,` +
      `position.ilike.%${search}%`
    );

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({ employees: data, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /employees:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/employees/:id ───────────────────────────────────
router.get('/:id', auth.verify, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    if (!data)  return res.status(404).json({ error: 'Employee not found.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/employees ──────────────────────────────────────
router.post('/', ...hrOnly, async (req, res) => {
  try {
    const payload = sanitizeEmployee(req.body);
    const errors  = validateEmployee(payload);
    if (errors.length) return res.status(400).json({ error: errors.join(' | ') });

    // Auto-generate employee_id if not provided
    if (!payload.employee_id) {
      const year = new Date().getFullYear();
      const { count } = await supabase.from('employees').select('*', { count:'exact', head:true });
      payload.employee_id = `EMP-${year}-${String((count || 0) + 1).padStart(3, '0')}`;
    }

    const { data, error } = await supabase
      .from('employees')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;

    await log(req, 'CREATE_EMPLOYEE', 'employees', data.id, { name: `${data.first_name} ${data.last_name}` });
    res.status(201).json(data);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An employee with this email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/employees/:id ───────────────────────────────────
router.put('/:id', ...hrOnly, async (req, res) => {
  try {
    const payload = sanitizeEmployee(req.body);
    delete payload.employee_id; // Don't allow changing EMP ID

    const { data, error } = await supabase
      .from('employees')
      .update({ ...payload, updated_at: new Date() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    if (!data)  return res.status(404).json({ error: 'Employee not found.' });

    await log(req, 'UPDATE_EMPLOYEE', 'employees', req.params.id, {});
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/employees/:id (archive, not hard delete) ─────
router.delete('/:id', ...hrOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .update({ employment_status: 'inactive', updated_at: new Date() })
      .eq('id', req.params.id)
      .select('id, first_name, last_name')
      .single();
    if (error) throw error;
    await log(req, 'ARCHIVE_EMPLOYEE', 'employees', req.params.id, {});
    res.json({ message: `${data.first_name} ${data.last_name} has been archived.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/employees/bulk-import ─────────────────────────
// Accepts a CSV file with headers:
// first_name,last_name,email,position,department,employment_type,
// date_hired,basic_salary,sss_number,philhealth_number,pagibig_number,tin
router.post('/bulk-import', ...hrOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a CSV file.' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), {
      columns         : true,
      skip_empty_lines: true,
      trim            : true,
    });
  } catch (parseErr) {
    return res.status(400).json({ error: 'Invalid CSV format. ' + parseErr.message });
  }

  if (!records.length) return res.status(400).json({ error: 'CSV file is empty.' });

  const year      = new Date().getFullYear();
  const { count } = await supabase.from('employees').select('*', { count:'exact', head:true });
  let   startIdx  = (count || 0) + 1;

  const results = { created: 0, skipped: 0, errors: [] };
  const toInsert = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const rowNum = i + 2; // 1-indexed + header row

    if (!row.first_name || !row.last_name || !row.email) {
      results.errors.push(`Row ${rowNum}: first_name, last_name, and email are required.`);
      results.skipped++;
      continue;
    }

    if (!isValidEmail(row.email)) {
      results.errors.push(`Row ${rowNum}: "${row.email}" is not a valid email.`);
      results.skipped++;
      continue;
    }

    const salary = parseFloat(row.basic_salary) || 0;
    if (salary <= 0) {
      results.errors.push(`Row ${rowNum}: basic_salary must be a positive number.`);
      results.skipped++;
      continue;
    }

    toInsert.push({
      employee_id      : row.employee_id || `EMP-${year}-${String(startIdx++).padStart(3,'0')}`,
      first_name       : row.first_name.trim(),
      last_name        : row.last_name.trim(),
      email            : row.email.toLowerCase().trim(),
      position         : row.position       || null,
      department       : row.department     || null,
      employment_type  : normalizeEmpType(row.employment_type),
      employment_status: 'active',
      date_hired       : row.date_hired     || null,
      basic_salary     : salary,
      sss_number       : row.sss_number     || null,
      philhealth_number: row.philhealth_number || null,
      pagibig_number   : row.pagibig_number || null,
      tin              : row.tin            || null,
    });
  }

  // Insert in batches of 20 (Supabase best practice)
  const BATCH = 20;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from('employees').insert(batch);
    if (error) {
      // If duplicate email, skip that row
      if (error.code === '23505') {
        results.skipped += batch.length;
        results.errors.push(`Batch ${i/BATCH + 1}: One or more emails already exist – rows skipped.`);
      } else {
        return res.status(500).json({ error: error.message, ...results });
      }
    } else {
      results.created += batch.length;
    }
  }

  await log(req, 'BULK_IMPORT_EMPLOYEES', 'employees', null, { ...results });
  res.json({
    message: `Import complete. ${results.created} added, ${results.skipped} skipped.`,
    ...results
  });
});

// ─── GET /api/employees/template/csv ──────────────────────────
// Returns a sample CSV for bulk import
router.get('/template/csv', auth.verify, (_req, res) => {
  const header = 'first_name,last_name,email,position,department,employment_type,date_hired,basic_salary,sss_number,philhealth_number,pagibig_number,tin';
  const sample = 'Juan,dela Cruz,juan@company.com,Software Engineer,Engineering,regular,2024-01-15,35000,34-1234567-8,12-345678901-2,1234-5678-9,123-456-789-000';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="numa_employee_import_template.csv"');
  res.send(header + '\n' + sample + '\n');
});

// ─── HELPERS ──────────────────────────────────────────────────
function sanitizeEmployee(body) {
  return {
    employee_id      : body.employee_id       || undefined,
    first_name       : (body.first_name       || '').trim(),
    last_name        : (body.last_name        || '').trim(),
    middle_name      : (body.middle_name      || null),
    email            : (body.email            || '').toLowerCase().trim(),
    phone            : body.phone             || null,
    address          : body.address           || null,
    position         : body.position          || null,
    department       : body.department        || null,
    employment_type  : normalizeEmpType(body.employment_type),
    employment_status: body.employment_status || 'active',
    date_hired       : body.date_hired        || null,
    date_regularized : body.date_regularized  || null,
    basic_salary     : parseFloat(body.basic_salary) || 0,
    sss_number       : body.sss_number        || null,
    philhealth_number: body.philhealth_number || null,
    pagibig_number   : body.pagibig_number    || null,
    tin              : body.tin               || null,
    supervisor_id    : body.supervisor_id     || null,
    profile_photo    : body.profile_photo     || null,
    emergency_contact_name        : body.emergency_contact_name         || null,
    emergency_contact_phone       : body.emergency_contact_phone        || null,
    emergency_contact_relationship: body.emergency_contact_relationship  || null,
  };
}

function validateEmployee(e) {
  const errors = [];
  if (!e.first_name)                errors.push('First name is required.');
  if (!e.last_name)                 errors.push('Last name is required.');
  if (!e.email)                     errors.push('Email is required.');
  else if (!isValidEmail(e.email))  errors.push('Email address is not valid.');
  if (!e.basic_salary || e.basic_salary <= 0) errors.push('Basic salary must be greater than zero.');
  return errors;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmpType(type) {
  const t = (type || '').toLowerCase().trim();
  if (['regular','probationary','contractual','part-time','project-based'].includes(t)) return t;
  return 'probationary';
}

async function log(req, action, resource, id, details) {
  try {
    await supabase.from('activity_logs').insert({
      user_id    : req.user?.id,
      user_email : req.user?.email,
      action,
      resource,
      resource_id: id,
      details,
      ip_address : req.ip,
    });
  } catch (_) { /* non-blocking */ }
}

module.exports = router;
