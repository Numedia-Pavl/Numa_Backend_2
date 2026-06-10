const jwt      = require('jsonwebtoken');
const { supabase } = require('./supabase');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('⚠️  JWT_SECRET is not set. Auth will not work.');
}

/**
 * verify – validates the Bearer token and attaches req.user
 */
async function verify(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token      = authHeader.replace(/^Bearer\s+/i, '');

    if (!token) {
      return res.status(401).json({ error: 'Not logged in. Please sign in to continue.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtErr) {
      if (jwtErr.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      }
      return res.status(401).json({ error: 'Invalid session. Please sign in again.' });
    }

    // Fetch fresh user record (picks up role changes)
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, roles, employment_status')
      .eq('id', decoded.id)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Account not found. Please contact your HR administrator.' });
    }

    if (user.employment_status === 'inactive') {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact your HR administrator.' });
    }

    req.user = {
      id    : user.id,
      email : user.email,
      roles : user.roles || [],
    };

    // Resolve employee_id from the employees table if not in token
    if (!req.user.employee_id) {
      const { data: emp } = await supabase
        .from('employees')
        .select('id')
        .eq('email', user.email)
        .single();
      req.user.employee_id = emp?.id || null;
    }

    next();
  } catch (err) {
    console.error('authMiddleware error:', err.message);
    res.status(500).json({ error: 'Authentication error. Please try again.' });
  }
}

/**
 * requireRole(allowedRoles) – middleware factory
 * Usage: router.get('/path', auth.verify, auth.requireRole(['admin','hr']), handler)
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const userRoles = req.user.roles || [];
    const hasRole   = allowedRoles.some(r => userRoles.includes(r));
    if (!hasRole) {
      return res.status(403).json({
        error: `Access denied. You need one of these roles: ${allowedRoles.join(', ')}.`
      });
    }
    next();
  };
}

/**
 * hasRole(req, roles) – inline check inside a handler
 */
function hasRole(req, roles) {
  const userRoles = req.user?.roles || [];
  return roles.some(r => userRoles.includes(r));
}

const isAdmin   = (req) => hasRole(req, ['admin']);
const isHR      = (req) => hasRole(req, ['admin','hr','hr_manager']);
const isManager = (req) => hasRole(req, ['admin','hr','hr_manager','manager','supervisor','department_head']);

module.exports = { verify, requireRole, hasRole, isAdmin, isHR, isManager };
