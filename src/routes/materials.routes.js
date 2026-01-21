// src/routes/materials.routes.js
const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  // catalog
  listMaterials,
  createMaterial,
  getMaterial,
  updateMaterial,
  deleteMaterial,

  // movements
  listMovements,
  createMovement,
  materialsStock,
  // summary
  materialsSummary,
} = require("../controllers/materials.controller");

router.use(requireAuth);

// ⚠️ rotas específicas ANTES de "/:id"
router.get("/summary", materialsSummary);

router.get("/movements", listMovements);
router.post("/movements", createMovement);

// catálogo
router.get("/", listMaterials);
router.post("/", createMaterial);

router.get("/:id", getMaterial);
router.patch("/:id", updateMaterial);
router.delete("/:id", deleteMaterial);
router.get("/stock", materialsStock);

module.exports = router;
