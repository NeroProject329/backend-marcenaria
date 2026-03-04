// src/middlewares/adminAuth.middleware.js
const jwt = require("jsonwebtoken");
const { prisma } = require("../lib/prisma");

function getCookie(req, name) {
  const header = String(req.headers.cookie || "");
  if (!header) return null;

  const parts = header.split(";").map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function getAdminJwtSecret() {
  return process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
}

async function requireAdminAuth(req, res, next) {
  try {
    const cookieToken = getCookie(req, "admin_token");
    const header = String(req.headers.authorization || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;

    const token = cookieToken || bearer;
    if (!token) return res.status(401).json({ message: "Sem sessão de admin." });

    let payload;
    try {
      payload = jwt.verify(token, getAdminJwtSecret());
    } catch {
      return res.status(401).json({ message: "Sessão de admin inválida." });
    }

    const adminUserId = payload?.adminUserId;
    if (!adminUserId) return res.status(401).json({ message: "Sessão de admin inválida." });

    const admin = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        mustChangePassword: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!admin || !admin.isActive) {
      return res.status(403).json({ message: "Admin desativado ou não encontrado." });
    }

    req.admin = admin;
    return next();
  } catch {
    return res.status(500).json({ message: "Erro ao validar admin." });
  }
}

module.exports = { requireAdminAuth };