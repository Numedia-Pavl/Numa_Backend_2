const express = require('express');
const router  = express.Router();
const { supabase } = require('./supabase');
const auth    = require('./authMiddleware');

// GET /api/settings
router.get('/', auth.verify, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('company_settings')
      .select('*')
      .limit(1)
      .single();
    if (error) throw error;
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
router.put('/', auth.verify, auth.requireRole(['admin']), async (req, res) => {
  try {
    const {
      company_name, company_address, company_tin,
      working_days, pay_frequency, logo_url
    } = req.body;

    const { data, error } = await supabase
      .from('company_settings')
      .upsert({
        company_name    : company_name    || 'My Company',
        company_address : company_address || null,
        company_tin     : company_tin     || null,
        working_days    : parseInt(working_days) || 22,
        pay_frequency   : pay_frequency   || 'semi-monthly',
        logo_url        : logo_url        || null,
        updated_at      : new Date(),
      })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
