// src/controllers/adminAuth.controller.js
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { prisma } = require("../lib/prisma");

function isProd() {
  return process.env.NODE_ENV === "production";
}

function getAdminJwtSecret() {
  return process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
}

function cookieOptions(req) {
  const prod = isProd();

  // Se o painel estiver em http://localhost, NÃO use secure + samesite none
  const origin = String(req.headers.origin || "");
  const isLocalhost =
    origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1");

  return {
    httpOnly: true,
    secure: prod && !isLocalhost, // prod: true | localhost: false
    sameSite: prod && !isLocalhost ? "none" : "lax", // prod cross-site: none | localhost: lax
    path: "/",
    maxAge: Number(process.env.ADMIN_TOKEN_DAYS || 7) * 24 * 60 * 60 * 1000,
  };
}

function signAdminToken(adminUserId) {
  return jwt.sign({ adminUserId, role: "ADMIN" }, getAdminJwtSecret(), {
    expiresIn: `${Number(process.env.ADMIN_TOKEN_DAYS || 7)}d`,
  });
}

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || null;
}

async function logAction(adminUserId, action, req, details) {
  try {
    await prisma.adminActionLog.create({
      data: {
        adminUserId,
        action,
        detailsJson: details ? JSON.stringify(details) : null,
        ip: clientIp(req),
        userAgent: String(req.headers["user-agent"] || ""),
      },
    });
  } catch (_) {
    // não quebra auth por falha de log
  }
}

// POST /api/admin/auth/login
async function login(req, res) {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ message: "Informe email e password." });
    }

    const admin = await prisma.adminUser.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        password: true,
        isActive: true,
        mustChangePassword: true,
      },
    });

    if (!admin || !admin.isActive) {
      return res.status(401).json({ message: "Credenciais inválidas." });
    }

    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) return res.status(401).json({ message: "Credenciais inválidas." });

    const token = signAdminToken(admin.id);

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    await logAction(admin.id, "ADMIN_LOGIN", req, { email });

    res.cookie("admin_token", token, cookieOptions(req));
    return res.json({
      admin: { id: admin.id, email: admin.email, name: admin.name, mustChangePassword: admin.mustChangePassword },
    });
  } catch (e) {
    return res.status(500).json({ message: "Erro interno no login admin.", error: e?.message || String(e) });
  }
}

// GET /api/admin/auth/me
async function me(req, res) {
  return res.json({ admin: req.admin });
}

// POST /api/admin/auth/logout
async function logout(req, res) {
  try {
    if (req.admin?.id) {
      await logAction(req.admin.id, "ADMIN_LOGOUT", req, null);
    }
  } catch (_) {}

  res.clearCookie("admin_token", { path: "/" });
  return res.json({ ok: true });
}

// POST /api/admin/auth/change-password
async function changePassword(req, res) {
  try {
    const adminId = req.admin?.id;
    if (!adminId) return res.status(401).json({ message: "Sem sessão de admin." });

    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Informe currentPassword e newPassword." });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "A nova senha deve ter pelo menos 8 caracteres." });
    }

    const admin = await prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, password: true, mustChangePassword: true, email: true },
    });

    if (!admin) return res.status(404).json({ message: "Admin não encontrado." });

    const ok = await bcrypt.compare(currentPassword, admin.password);
    if (!ok) return res.status(401).json({ message: "Senha atual inválida." });

    const hash = await bcrypt.hash(newPassword, 10);

    await prisma.adminUser.update({
      where: { id: adminId },
      data: { password: hash, mustChangePassword: false },
    });

    await logAction(adminId, "ADMIN_CHANGE_PASSWORD", req, { email: admin.email });

    // rotaciona cookie
    const token = signAdminToken(adminId);
    res.cookie("admin_token", token, cookieOptions(req));

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: "Erro ao trocar senha.", error: e?.message || String(e) });
  }
}

module.exports = {
  login,
  me,
  logout,
  changePassword,
};