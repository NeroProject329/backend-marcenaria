// src/controllers/auth.controller.js
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { prisma } = require("../lib/prisma");

function signToken({ userId, salonId }) {
  return jwt.sign({ userId, salonId }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function daysLeft(endsAt) {
  if (!endsAt) return null;
  const now = new Date();
  const end = new Date(endsAt);
  const diff = end.getTime() - now.getTime();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function computeSubscription(salon) {
  const now = new Date();

  const overrideEnabled = !!salon?.planOverrideEnabled;
  const overrideEndsAt = salon?.planOverrideEndsAt ? new Date(salon.planOverrideEndsAt) : null;
  const overrideActive = overrideEnabled && (!overrideEndsAt || overrideEndsAt >= now);

  const effectivePlan = String(
    overrideActive ? (salon.planOverridePlan || salon.plan) : salon.plan
  ).toUpperCase();

  const effectiveEndsAt = overrideActive
    ? (overrideEndsAt || salon.planEndsAt || null)
    : (salon.planEndsAt || null);

  if (overrideActive) {
    return {
      plan: effectivePlan,
      status: "ACTIVE",
      source: "OVERRIDE",
      endsAt: effectiveEndsAt,
      daysLeft: daysLeft(effectiveEndsAt),
      cancelAtPeriodEnd: false,
    };
  }

  const end = effectiveEndsAt ? new Date(effectiveEndsAt) : null;
  const dLeft = end ? daysLeft(end) : null;

  if (end && end < now) {
    return {
      plan: effectivePlan,
      status: "EXPIRED",
      source: "SUBSCRIPTION",
      endsAt: effectiveEndsAt,
      daysLeft: 0,
      cancelAtPeriodEnd: !!salon.cancelAtPeriodEnd,
    };
  }

  if (salon.cancelAtPeriodEnd) {
    return {
      plan: effectivePlan,
      status: "CANCEL_SCHEDULED",
      source: "SUBSCRIPTION",
      endsAt: effectiveEndsAt,
      daysLeft: dLeft,
      cancelAtPeriodEnd: true,
    };
  }

  if (typeof dLeft === "number" && dLeft <= 7) {
    return {
      plan: effectivePlan,
      status: "EXPIRING",
      source: "SUBSCRIPTION",
      endsAt: effectiveEndsAt,
      daysLeft: dLeft,
      cancelAtPeriodEnd: false,
    };
  }

  return {
    plan: effectivePlan,
    status: "ACTIVE",
    source: "SUBSCRIPTION",
    endsAt: effectiveEndsAt,
    daysLeft: dLeft,
    cancelAtPeriodEnd: false,
  };
}

async function register(req, res) {
  try {
    const { name, email, phone, password, salonName } = req.body;

    if (!name || !email || !password || !salonName) {
      return res.status(400).json({ message: "Campos obrigatórios: name, email, password, salonName" });
    }

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ message: "E-mail já cadastrado" });

    const hash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        phone: phone || null,
        password: hash,
        salon: { create: { name: salonName } },
      },
      include: { salon: true },
    });

    const token = signToken({ userId: user.id, salonId: user.salon.id });

    return res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      salon: { id: user.salon.id, name: user.salon.name },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Erro interno" });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Informe email e password" });

    const user = await prisma.user.findUnique({
      where: { email },
      include: { salon: true },
    });

    if (!user) return res.status(401).json({ message: "Credenciais inválidas" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Credenciais inválidas" });

    if (!user.salon) return res.status(403).json({ message: "Conta sem salão vinculado" });

    const token = signToken({ userId: user.id, salonId: user.salon.id });

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      salon: { id: user.salon.id, name: user.salon.name },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Erro interno" });
  }
}

async function me(req, res) {
  const { userId } = req.user;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      salon: {
        select: {
          id: true,
          name: true,

          plan: true,
          planStatus: true,
          planEndsAt: true,
          trialEndsAt: true,

          cancelAtPeriodEnd: true,
          cancelRequestedAt: true,

          planOverrideEnabled: true,
          planOverridePlan: true,
          planOverrideEndsAt: true,
          planOverrideReason: true,
        },
      },
    },
  });

  const subscription = user?.salon ? computeSubscription(user.salon) : null;

  return res.json({ user, subscription });
}

module.exports = { register, login, me };