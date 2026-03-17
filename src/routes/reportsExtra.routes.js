// src/routes/reportsExtra.routes.js
const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  reportPack,
  reportPackPdf,
  reportSalesHistoryPdf,
} = require("../controllers/reportsExtra.controller");

router.use(requireAuth);

// JSON “pack” (front usa pra renderizar)
router.get("/pack", reportPack);

// PDF bonito
router.get("/pack.pdf", reportPackPdf);

// PDF do histórico de vendas
router.get("/sales-history.pdf", reportSalesHistoryPdf);

module.exports = router;