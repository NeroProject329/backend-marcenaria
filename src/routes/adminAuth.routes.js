// src/routes/adminAuth.routes.js
const router = require("express").Router();
const {
  login,
  me,
  logout,
  changePassword,
} = require("../controllers/adminAuth.controller");

const { requireAdminAuth } = require("../middlewares/adminAuth.middleware");

router.post("/login", login);
router.get("/me", requireAdminAuth, me);
router.post("/logout", requireAdminAuth, logout);
router.post("/change-password", requireAdminAuth, changePassword);

module.exports = router;