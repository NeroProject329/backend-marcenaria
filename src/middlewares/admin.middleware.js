function requireAdminSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(500).json({ message: "ADMIN_SECRET não configurado." });

  const header = req.headers["x-admin-secret"];
  if (!header || header !== secret) {
    return res.status(403).json({ message: "Sem permissão." });
  }

  next();
}

module.exports = { requireAdminSecret };
