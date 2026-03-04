// src/routes/webhooks.routes.js
const router = require("express").Router();
const express = require("express");
const { abacatepayWebhook } = require("../controllers/webhooks.abacatepay.controller");

// ✅ RAW BODY apenas aqui (não pode passar por express.json antes)
router.post(
  "/abacatepay",
  express.raw({ type: "application/json", limit: "1mb" }),
  abacatepayWebhook
);

module.exports = router;