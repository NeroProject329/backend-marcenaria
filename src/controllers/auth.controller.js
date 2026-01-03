const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { prisma } = require("../lib/prisma");

function signToken({ userId, salonId }) {
  return jwt.sign({ userId, salonId }, process.env.JWT_SECRET, { expiresIn: "7d" });
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

    // Cria usuário + salão (1 conta = 1 salão)
    const user = await prisma.user.create({
      data: {
        name,
        email,
        phone: phone || null,
        password: hash,
        salon: {
          create: {
            name: salonName,
            phone: phone || null
          }
        }
      },
      include: { salon: true }
    });

    const token = signToken({ userId: user.id, salonId: user.salon.id });

    return res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      salon: { id: user.salon.id, name: user.salon.name }
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
      include: { salon: true }
    });

    if (!user) return res.status(401).json({ message: "Credenciais inválidas" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Credenciais inválidas" });

    if (!user.salon) return res.status(403).json({ message: "Conta sem salão vinculado" });

    const token = signToken({ userId: user.id, salonId: user.salon.id });

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      salon: { id: user.salon.id, name: user.salon.name }
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
    select: { id: true, name: true, email: true, phone: true, salon: { select: { id: true, name: true } } }
  });
  return res.json({ user });
}

module.exports = { register, login, me };
