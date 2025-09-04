// index.js - NEW form service (port 4001)

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const app = express();
app.set("trust proxy", true);

// CONFIG
const PORT = process.env.PORT || 4001;
const SHEET_URL = process.env.SHEET_URL || "https://script.google.com/macros/s/AKfycbxk4sV2xLZcKbnMQRtaMer-FxeFsUk1JjvivIK4g6f5fFFlXvQfzD92GsbEurjN7Fvw/exec";
const ROCKETOUR_URL = process.env.ROCKETOUR_URL || "https://rocketour.co/affiliate-form/";
const AFFILIATE_ID = process.env.AFFILIATE_ID || "242";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://saveforyourtrip.com";

// LOGS
const LOG_DIR = path.join(__dirname, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const GENERAL_LOG = path.join(LOG_DIR, "submission.log");
const SHEET_FAIL_LOG = path.join(LOG_DIR, "sheet_fail.log");
const ROCKETOUR_LOG = path.join(LOG_DIR, "rockettour.log");

// Helper: append JSON line
function appendJsonLine(file, obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
  fs.appendFile(file, line, err => { if (err) console.error("Log write failed:", err); });
}

function logConsole(msg, obj) {
  console.log(`[${new Date().toISOString()}] ${msg}`, obj || "");
}

// MIDDLEWARE
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Health check
app.get("/formnew/healthz", (_, res) => res.send("OK - new form service"));

// Main submit endpoint
app.post("/formnew/submit", async (req, res) => {
  const payload = req.body || {};
  const source = (payload.source || "form").toString().toLowerCase(); // form | whatsapp

  // 1) Always log locally first
  appendJsonLine(GENERAL_LOG, { source, payload });

  // 2) Try sending to Google Sheets (await)
  try {
    const sheetResp = await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!sheetResp.ok) {
      const text = await sheetResp.text().catch(() => "");
      appendJsonLine(SHEET_FAIL_LOG, { status: sheetResp.status, text, payload });
      logConsole("Google Sheets returned non-OK", { status: sheetResp.status, text });
    } else {
      logConsole("Saved to Google Sheets successfully.");
    }
  } catch (err) {
    appendJsonLine(SHEET_FAIL_LOG, { error: err.message || String(err), payload });
    logConsole("Google Sheets exception:", err);
  }

  // 3) Respond immediately (don't wait for Rockettour)
  res.status(200).json({ ok: true });

  // 4) Background Rockettour submission
  backgroundRocketourSubmission(payload, source).catch(err =>
    logConsole("Background Rockettour submission failed:", err)
  );
});

// Background function
async function backgroundRocketourSubmission(data, src) {
  logConsole("Rockettour background submission started.", { source: src });

  try {
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(ROCKETOUR_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Fill fields
    if (await page.$('input[name="affiliateId"]')) {
      await page.type('input[name="affiliateId"]', AFFILIATE_ID);
    }
    if (await page.$('input[name="city"]')) {
      await page.type('input[name="city"]', "רומא");
    }
    if (await page.$('input[name="leadName"]')) {
      await page.type('input[name="leadName"]', data.name || "");
    }
    if (await page.$('input[name="leadPhone"]')) {
      await page.type('input[name="leadPhone"]', data.phone || "");
    }

    // Build notes
    const notes = [
      data.tour_details,
      data.tours ? (Array.isArray(data.tours) ? data.tours.join(", ") : data.tours) : "",
      data.npart ? `מספר משתתפים: ${data.npart}` : "",
      data.participants ? `מספר משתתפים: ${data.participants}` : "",
      src === "whatsapp" ? "נשלח מוואטסאפ" : "נשלח מהטופס",
    ].filter(Boolean).join("\n");

    if (await page.$('textarea[name="notes"]')) {
      await page.type('textarea[name="notes"]', notes);
    }

    // Submit
    const submitHandle = await page.$('button[type="submit"], input[type="submit"]');
    if (submitHandle) {
      await submitHandle.click();
      try {
        await page.waitForSelector('div[class*="bg-green"], div[class*="bg-green-50"]', { timeout: 5000 });
        appendJsonLine(ROCKETOUR_LOG, { status: "success", payload: data });
        logConsole("Rockettour submission successful.");
      } catch {
        appendJsonLine(ROCKETOUR_LOG, { status: "submitted_no_success_message", payload: data });
        logConsole("Rockettour submitted but no success message detected.");
      }
    } else {
      appendJsonLine(ROCKETOUR_LOG, { error: "no_submit_button_found", payload: data });
      logConsole("Rockettour: no submit button found.");
    }

    await browser.close();
  } catch (err) {
    appendJsonLine(ROCKETOUR_LOG, { error: err.message || String(err), payload: data });
    logConsole("Rockettour background error:", err.message || err);
  }
}

// Start server
app.listen(PORT, () => logConsole(`NEW form service listening on port ${PORT}`));

