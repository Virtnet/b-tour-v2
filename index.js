const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();

// CONFIG
const PORT = process.env.PORT || 4001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://saveforyourtrip.com";

// Middleware
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Health check
app.get("/formnew/healthz", (req, res) => {
  res.send("OK - new form service");
});

// Dummy submit (no puppeteer yet)
app.post("/formnew/submit", (req, res) => {
  console.log("Received submission:", req.body);
  res.status(200).json({ ok: true, message: "Submission received (dummy)" });
});

// Start server
app.listen(PORT, () => {
  console.log(`NEW form service listening on port ${PORT}`);
});
