/**
 * Zerodha Holdings Import — Google Drive Web App
 * ------------------------------------------------
 * A brand new, standalone Apps Script project — fully separate from
 * the existing live-price script (different project, different
 * deployment, different URL). Its only job: scan a designated Drive
 * folder for the most recently modified .xlsx file (expected to be a
 * Zerodha Console "Holdings" export with Stocks / Mutual funds / Gold
 * sheets), convert it to a temporary Google Sheet, read those three
 * tabs, and return their rows as JSON.
 *
 * ---- ONE-TIME SETUP ----
 * 1. script.google.com -> New project. Paste this file in as the
 *    only .gs file (rename Code.gs's contents to this, or add as a
 *    new file — either is fine).
 * 2. Create (or pick) a Drive folder to hold Zerodha Holdings
 *    exports. Open it in Drive, copy the folder ID out of the URL:
 *    https://drive.google.com/drive/folders/<THIS PART>
 *    Paste it into FOLDER_ID below.
 * 3. In the Apps Script editor: Services (+ icon next to
 *    "Services" in the left sidebar) -> add "Drive API" (this adds
 *    the Advanced Drive Service, needed to convert .xlsx -> Google
 *    Sheets format — SpreadsheetApp alone can't open .xlsx blobs).
 *    If prompted to also enable it in the linked Google Cloud
 *    project, do that too.
 * 4. Deploy -> New deployment -> gear icon -> type "Web app".
 *    Execute as: Me. Who has access: Anyone. Deploy, then authorize
 *    when prompted (this script needs Drive access to read/convert/
 *    delete files in that one folder).
 * 5. Copy the resulting /exec URL into HOLDINGS_API_URL in app.js.
 *
 * ---- ONGOING USE ----
 * Whenever you have a fresh Holdings export from Zerodha Console,
 * just drop the .xlsx file into that Drive folder — any filename is
 * fine. The script always reads whichever .xlsx in the folder was
 * modified most recently, so you don't need to rename or delete
 * anything; old exports can be left there or cleaned out later,
 * whichever's convenient.
 */

const FOLDER_ID = "PASTE_YOUR_DRIVE_FOLDER_ID_HERE";

// Sheet tab names inside the Zerodha export — must match exactly
// (case-sensitive), same convention as ZERODHA_SHEETS in app.js.
const SHEET_NAMES = { stocks: "Stocks", mf: "Mutual funds", gold: "Gold" };

function doGet() {
  try {
    const file = findMostRecentXlsx(FOLDER_ID);
    if (!file) {
      return jsonOutput({
        error: "No .xlsx file found in the designated Drive folder. Upload a Zerodha Console Holdings export there first."
      });
    }

    const tempSheetFile = convertXlsxToTempSheet(file);
    try {
      const ss = SpreadsheetApp.openById(tempSheetFile.id);
      const result = {
        sourceFileName: file.getName(),
        fileUpdated: file.getLastUpdated().toISOString(),
        stocks: sheetToObjects(ss.getSheetByName(SHEET_NAMES.stocks)),
        mf: sheetToObjects(ss.getSheetByName(SHEET_NAMES.mf)),
        gold: sheetToObjects(ss.getSheetByName(SHEET_NAMES.gold))
      };
      return jsonOutput(result);
    } finally {
      // Always clean up the temporary converted copy, even if reading
      // the sheets above threw — never leave conversion clutter behind
      // in Drive just because one run failed partway through.
      DriveApp.getFileById(tempSheetFile.id).setTrashed(true);
    }
  } catch (err) {
    return jsonOutput({ error: String(err && err.message ? err.message : err) });
  }
}

// Scans FOLDER_ID for .xlsx files and returns the one with the latest
// getLastUpdated() timestamp — the file Ganesh most recently dropped
// in, regardless of its name.
function findMostRecentXlsx(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const files = folder.getFilesByType(XLSX_MIME);
  let best = null;
  while (files.hasNext()) {
    const f = files.next();
    if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
  }
  return best;
}

// Converts an .xlsx Drive file into a temporary native Google Sheet
// via the Advanced Drive Service (Drive.Files.copy with a Sheets
// target MIME type triggers Drive's own xlsx->Sheets conversion) so
// SpreadsheetApp can read it. The caller is responsible for trashing
// the returned file once done with it.
function convertXlsxToTempSheet(xlsxFile) {
  const resource = {
    title: "TEMP_holdings_import_" + new Date().getTime(),
    mimeType: MimeType.GOOGLE_SHEETS
  };
  return Drive.Files.copy(resource, xlsxFile.getId());
}

// Row 1 = header. Returns an array of objects keyed by header text
// (e.g. "Symbol", "Qty.", "Buy avg.", "Buy value") — same convention
// the existing live-price script already uses for its Stocks/Mutual
// Funds/ETF tabs, so app.js's flexible header-matching helpers work
// against this unchanged. Returns null if the sheet wasn't found (a
// missing tab in the source workbook), so app.js can tell "empty
// sheet" apart from "sheet doesn't exist".
function sheetToObjects(sheet) {
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => String(h).trim());
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
