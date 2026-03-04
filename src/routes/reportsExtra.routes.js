// src/routes/reportsExtra.routes.js
const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { reportPack, reportPackPdf } = require("../controllers/reportsExtra.controller");

router.use(requireAuth);

// JSON “pack” (front usa pra renderizar)
router.get("/pack", reportPack);

// PDF bonito
router.get("/pack.pdf", reportPackPdf);

module.exports = router;