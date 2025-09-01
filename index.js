// index.js (NEW PARALLEL SERVICE ON PORT 4001)
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

// ---------- CONFIG (use env in prod) ----------
const PORT = process.env.PORT || 4001; // <-- NEW PORT
const SHEET_URL = process.env.SHEET_URL || "https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec";
const ROCKETOUR_URL = process.env.ROCKETOUR_URL || "https://rocketour.co/affiliate-form/";
const AFFILIATE_ID = process.env.AFFILIATE_ID || "242";

// CORS: since we’ll hit this via https://saveforyourtrip.com/formnew from the same origin,
// you could even disable CORS here. Keeping it strict is fine too:
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://saveforyourtrip.com";

// ---------- LOGGING ----------
const LOG_DIR = path.join(__dirname, "logs");
const GENERAL_LOG = path.join(LOG_DIR, "submission.log");
const WHATSAPP_LOG = path.join(LOG_DIR, "whatsapp.log");
const SHEET_FAIL_LOG = path.join(LOG_DIR, "sheet_fail.log");
const ROCKETOUR_LOG = path.join(LOG_DIR, "rockettour.log");

// ensure logs dir exists
fs.mkdirSync(LOG_DIR, { recursive: true });

function append(file, lineObj) {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, ...lineObj }) + "\n";
  fs.appendFile(file, line, (err) => {
    if (err) console.error("Log write failed:", err);
  });
}

function logConsole(msg, obj) {
  if (obj) console.log(`[${new Date().toISOString()}] ${msg}`, obj);
  else console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------- APP ----------
const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

app.get("/healthz", (_, res) => res.send("OK (new form service)"));
// You’ll proxy /formnew here via Nginx (see below).
// So your frontend will call:  POST https://saveforyourtrip.com/formnew/submit

app.post("/submit", async (req, res) => {
  const payload = req.body || {};
  const source = payload.source || "Form"; // "Form" or "WhatsApp" (you can pass this from client)
  const ip = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.ip;

  // ALWAYS append to a local rolling log first to avoid any data loss
  append(GENERAL_LOG, { ip, source, payload });

  if (source.toLowerCase() === "whatsapp") {
    append(WHATSAPP_LOG, { ip, payload });
  }

  // 1) Try save to Google Sheet (await)
  try {
    const sheetResp = await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 15000
    });

    if (!sheetResp.ok) {
      const text = await sheetResp.text().catch(() => "");
      append(SHEET_FAIL_LOG, { status: sheetResp.status, text, payload });
      // we still return 200 to the client; the local file captured the lead
      logConsole("Google Sheets FAILED (captured locally).", { status: sheetResp.status, text });
    } else {
      logConsole("Google Sheets OK");
    }
  } catch (err) {
    append(SHEET_FAIL_LOG, { error: (err && err.message) || String(err), payload });
    logConsole("Google Sheets EXCEPTION (captured locally).", err);
  }

  // Respond to client immediately (non-blocking UX)
  res.status(200).json({ ok: true });

  // 2) Rocketour (background, don’t block client)
  if (source.toLowerCase() === "form") {
    (async () => {
      logConsole("Starting Rocketour background submission...");
      try {
        const browser = await puppeteer.launch({
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless
        });
        const page = await browser.newPage();

        await page.goto(ROCKETOUR_URL, { waitUntil: "networkidle2", timeout: 30000 });

        // Adjust selectors to match Rocketour’s form
        if (await page.$('input[name="affiliateId"]')) {
          await page.type('input[name="affiliateId"]', AFFILIATE_ID);
        }
        if (await page.$('input[name="city"]')) {
          await page.type('input[name="city"]', "רומא");
        }
        if (await page.$('input[name="leadName"]')) {
          await page.type('input[name="leadName"]', payload.name || "");
        }
        if (await page.$('input[name="leadPhone"]')) {
          await page.type('input[name="leadPhone"]', payload.phone || "");
        }

        const notesParts = [];
        if (payload.npart) notesParts.push(`מספר משתתפים: ${payload.npart}`);
        if (payload.participants) notesParts.push(`מספר משתתפים: ${payload.participants}`);
        if (payload.tour_details) notesParts.push(payload.tour_details);
        if (payload.tours) notesParts.push(Array.isArray(payload.tours) ? payload.tours.join(", ") : payload.tours);
        notesParts.push("נשלח בטופס");
        const notes = notesParts.filter(Boolean).join("\n");

        if (await page.$('textarea[name="notes"]')) {
          await page.type('textarea[name="notes"]', notes);
        }

        // Try common submit patterns safely
        const btnSubmit = await page.$('button[type="submit"], input[type="submit"]');
        if (btnSubmit) {
          await btnSubmit.click();
          await page.waitForTimeout(2000);
        } else {
          append(ROCKETOUR_LOG, { error: "No submit button found" });
        }

        // Detect success “green box” if present
        const success = await page.$('div[class*="bg-green"]');
        if (success) {
          append(ROCKETOUR_LOG, { status: "success", payload: { name: payload.name, phone: payload.phone } });
        } else {
          append(ROCKETOUR_LOG, { status: "unknown_state_no_green_box" });
        }

        await browser.close();
      } catch (bgErr) {
        append(ROCKETOUR_LOG, { error: (bgErr && bgErr.message) || String(bgErr) });
      }
    })();
  }
});

app.listen(PORT, () => logConsole(`NEW service listening on ${PORT}`));
