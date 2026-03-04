const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  // evita "Bearer null"/"Bearer undefined"
  if (!token || token === "null" || token === "undefined") {
    return res.status(401).json({ message: "Sem token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, salonId }
    return next();
  } catch (err) {
    if (err && err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expirado" });
    }
    return res.status(401).json({ message: "Token inválido" });
  }
}

module.exports = { requireAuth };