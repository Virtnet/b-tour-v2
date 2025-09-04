// index.js (NEW service - default port 4001)
// Purpose: receive submissions from form OR WhatsApp modal, save to Google Sheets,
// log locally (guarantee), and submit to Rocketour in background (non-blocking UX).

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch"); // v2 style require
const fs = require("fs");
const path = require("path");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const app = express();

// CONFIG - use env vars in production
const PORT = process.env.PORT || 4001;
const SHEET_URL = process.env.SHEET_URL || "https://script.google.com/macros/s/AKfycbxk4sV2xLZcKbnMQRtaMer-FxeFsUk1JjvivIK4g6f5fFFlXvQfzD92GsbEurjN7Fvw/exec";
const ROCKETOUR_URL = process.env.ROCKETOUR_URL || "https://rocketour.co/affiliate-form/";
const AFFILIATE_ID = process.env.AFFILIATE_ID || "242";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://saveforyourtrip.com"; // change if needed

// LOG FILES
const LOG_DIR = path.join(__dirname, "logs");
const GENERAL_LOG = path.join(LOG_DIR, "submission.log");
const WHATSAPP_LOG = path.join(LOG_DIR, "whatsapp.log");
const SHEET_FAIL_LOG = path.join(LOG_DIR, "sheet_fail.log");
const ROCKETOUR_LOG = path.join(LOG_DIR, "rockettour.log");

// ensure log dir
fs.mkdirSync(LOG_DIR, { recursive: true });

function appendJsonLine(filePath, obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
  fs.appendFile(filePath, line, (err) => {
    if (err) console.error("Log write failed:", err);
  });
}

function logConsole(msg, obj) {
  if (obj) console.log(`[${new Date().toISOString()}] ${msg}`, obj);
  else console.log(`[${new Date().toISOString()}] ${msg}`);
}

// MIDDLEWARE
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Health
app.get("/formnew/healthz", (req, res) => {
  res.send("OK - new form servic");
});

// MAIN endpoint (proxy path to this service e.g. /formnew/ -> 127.0.0.1:4001)
app.post("/formnew/submit", async (req, res) => {
  const payload = req.body || {};
  // expected fields: name,email,phone,datetour,npart,tours,tour_details,participants,source
  const source = (payload.source || "form").toString().toLowerCase(); // 'form' or 'whatsapp'
  const ip = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.ip;

  // Save locally first (guarantee)
  appendJsonLine(GENERAL_LOG, { ip, source, payload });

  if (source === "whatsapp") appendJsonLine(WHATSAPP_LOG, { ip, payload });

  // 1) Try saving to Google Sheets (await)
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
      logConsole("Saved to Google Sheets (OK).");
    }
  } catch (err) {
    appendJsonLine(SHEET_FAIL_LOG, { error: (err && err.message) || String(err), payload });
    logConsole("Google Sheets exception (saved locally).", err);
  }

  // Respond immediately to client so they don't wait
  res.status(200).json({ ok: true });

  // 2) Send to Rocketour in background (non-blocking)
  (async function backgroundRocketourSubmission(data, src, clientIp) {
    logConsole("Rocketour background submission started.", { source: src });

    try {
      const browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      const page = await browser.newPage();

      // navigation with a timeout (30s)
      await page.goto(ROCKETOUR_URL, { waitUntil: "networkidle2", timeout: 30000 });

      // Fill known fields only if present
      if (await page.$('input[name="affiliateId"]')) {
        await page.type('input[name="affiliateId"]', AFFILIATE_ID);
      }
      if (await page.$('input[name="city"]')) {
        await page.type('input[name="city"]', "רומא");
      }
      if (await page.$('input[name="leadName"]')) {
        await page.type('input[name="leadName"]', data.name ? String(data.name) : "");
      }
      if (await page.$('input[name="leadPhone"]')) {
        await page.type('input[name="leadPhone"]', data.phone ? String(data.phone) : "");
      }

      // Build notes: combine tour_details or tours with npart/participants
      const notesParts = [];
      if (data.npart) notesParts.push(`מספר משתתפים: ${data.npart}`);
      if (data.participants) notesParts.push(`מספר משתתפים: ${data.participants}`);
      if (data.tour_details) notesParts.push(data.tour_details);
      if (data.tours) {
        notesParts.push(Array.isArray(data.tours) ? data.tours.join(", ") : String(data.tours));
      }
      notesParts.push(src === "whatsapp" ? "נשלח בוואטסאפ" : "נשלח בטופס");
      const notes = notesParts.filter(Boolean).join("\n");

      if (await page.$('textarea[name="notes"]')) {
        await page.type('textarea[name="notes"]', notes);
      }

      // Try to click submit; try multiple patterns
      const submitHandle = await page.$('button[type="submit"], input[type="submit"], form button[type="submit"]');
      if (submitHandle) {
        await submitHandle.click();
        // wait short time for success message (non-blocking long wait)
        try {
          // many Rocketour pages show a green success div after submit — try to detect it
          await page.waitForSelector('div[class*="bg-green"], div[class*="bg-green-50"]', { timeout: 5000 });
          appendJsonLine(ROCKETOUR_LOG, { status: "success_detected", payload: data });
          logConsole("Rocketour: success box detected.");
        } catch (errSel) {
          // if not found, still consider submitted but log unknown state
          appendJsonLine(ROCKETOUR_LOG, { status: "submitted_no_green_box", payload: data });
          logConsole("Rocketour: submitted but no green success box found (logged).");
        }
      } else {
        appendJsonLine(ROCKETOUR_LOG, { error: "no_submit_button_found", payload: data });
        logConsole("Rocketour: no submit button found on page.");
      }

      await browser.close();
    } catch (bgErr) {
      appendJsonLine(ROCKETOUR_LOG, { error: (bgErr && bgErr.message) || String(bgErr), payload: data });
      logConsole("Rocketour background error:", bgErr && bgErr.message ? bgErr.message : bgErr);
    }
  })(payload, source, ip);
});

// Start server
app.listen(PORT, () => logConsole(`NEW form service listening on port ${PORT}`));


