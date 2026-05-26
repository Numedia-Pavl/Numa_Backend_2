'use strict';
const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token expired or invalid' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    const userRoles = Array.isArray(req.user.roles) ? req.user.roles : [req.user.role];
    const allowed   = roles.some(r => userRoles.includes(r));
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });
    next();
  };
}

module.exports = { authenticate, authorize };
