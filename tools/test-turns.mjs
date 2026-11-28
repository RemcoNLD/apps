// Turn instructions at motorway exits: fixtures with the expected target and exit number, run against
// the app's own turn functions in a headless browser (no network: every request is answered locally).
// Usage: node tools/test-turns.mjs [path/to/evailability.html]
// Needs Playwright; PLAYWRIGHT (module path) and CHROME (executable) can be set, defaults are the
// paths of Claude's sandbox. Add a case for every exit that went wrong on a drive.
import { createRequire } from "module";
import { readFileSync } from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "/home/claude/.npm-global/lib/node_modules/@playwright/mcp/node_modules/playwright");
const html = readFileSync(process.argv[2] || new URL("../evailability.html", import.meta.url), "utf8");

// turns: [km, type, name, exitNo, angle, flags, prevName] as the Worker sends them (turnsOf()).
// roads: the timeline's numbered roads; exits: [km, ref, name] on your side of the motorway.
// Each case: where you are (km), what the row should say (target) and which exit number goes with it.
const CASES = [
  { name: "Bodegraven: A12 exit to the N11, slip road named A12 (screenshot 28 Nov)", km: 4,
    roads: [["A12", 0, 21.0], ["N11", 22.3, 40], ["N434", 40, 45]],
    exits: [[10.0, "14", "Harmelen"], [20.1, "12", "Bodegraven"]],
    turns: [[20.2, 13, "A12", 0, 18, "", "A12"], [22.1, 5, "N11", 0, 25, "", "A12"]],
    target: "N11", exit: "12" },
  { name: "Bodegraven as on the screenshot: the A12 match ends 0.4 km past the turn", km: 4.2,
    roads: [["A12", 0, 20.6], ["N11", 22.3, 40], ["N434", 40, 45]],
    exits: [[10.0, "14", "Harmelen"], [20.1, "12", "Bodegraven"]],
    turns: [[20.2, 13, "A12", 0, 18, "", "A12"], [22.1, 5, "N11", 0, 25, "", "A12"]],
    target: "N11", exit: "12" },
  { name: "Houten: A27 exit, unnamed ramp, roundabout behind", km: 25,
    roads: [["A27", 0, 30.3]],
    exits: [[29.9, "29", "Houten"]],
    turns: [[30.0, 13, "", 0, 20, "", "A27"], [30.8, 7, "Rondweg", 2, 10, "r", ""]],
    target: "Rondweg", exit: "29" },
  { name: "Knooppunt Oudenrijn: A2 to A12 (motorway to motorway, no exit number)", km: 10,
    roads: [["A2", 0, 15.5], ["A12", 15.8, 50]],
    exits: [[15.0, "", "Oudenrijn"]],
    turns: [[15.0, 12, "A12", 0, -15, "", "A2"]],
    target: "A12", exit: "" },
  { name: "Lexmond: A27 exit named A27, roundabout to a village street", km: 30,
    roads: [["A27", 0, 40.8]],
    exits: [[35.0, "26", "Vianen"], [39.9, "27", "Lexmond"]],
    turns: [[40.0, 13, "A27", 0, 16, "", "A27"], [41.0, 7, "Dorpsstraat", 2, 5, "r", "A27"]],
    target: "Dorpsstraat", exit: "27" },
  { name: "Germany: A3 exit to the B8, ramp named \"A 3\"", km: 50,
    roads: [["A3", 0, 60.9], ["B8", 61.5, 80]],
    exits: [[60.1, "35", "Siegburg"]],
    turns: [[60.2, 13, "A 3", 0, 18, "", "A 3"]],
    target: "B8", exit: "35" },
  { name: "Nothing after the exit known: the exit's name", km: 45,
    roads: [["A12", 0, 50.6]],
    exits: [[49.9, "23", "Veenendaal"]],
    turns: [[50.0, 13, "A12", 0, 15, "", "A12"]],
    target: "Veenendaal", exit: "23" },
  { name: "Staying on the A12 at an exit (keep left): no instruction", km: 5,
    roads: [["A12", 0, 60]],
    exits: [[20.1, "12", "Bodegraven"]],
    turns: [[20.2, 12, "A12", 0, -8, "", "A12"], [59.0, 13, "", 0, 20, "", "A12"]],
    skipTo: 59.0 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome" });
const page = await browser.newPage();
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith("https://app.test/")) return r.fulfill({ contentType: "text/html", body: html });
  return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
await page.goto("https://app.test/evailability.html");
let failed = 0;
for (const c of CASES) {
  const got = await page.evaluate((c) => {
    state.stations = [];
    state.roadOverride = null;
    state.route = { distanceKm: 100, coords: [[5, 52], [5.1, 52.5]], km: [0, 100], min: [0, 60],
      roads: c.roads.map(([ref, fromKm, toKm]) => ({ ref, country: /^B\d/.test(ref) ? "DE" : "NL", fromKm, toKm })),
      exits: c.exits, turns: c.turns, borders: [] };
    state.user = { km: c.km, min: 0, offKm: 0, acc: 10, at: Date.now() };
    const t = nextTurn();
    if (!t) return { none: true };
    const box = document.createElement("div");
    box.innerHTML = turnRow();
    const sign = box.querySelector(".turn .exit-sign b");
    const target = box.querySelector(".turn .turn-txt, .turn .road, .turn [class*=badge], .turn .tl-badge");
    const turn = box.querySelector(".turn");
    return { km: t.km, exit: sign ? sign.textContent : "", text: turn ? turn.textContent : "", targetHtml: turnTarget(t) };
  }, c);
  let ok;
  if (c.skipTo != null) ok = got.km === c.skipTo;
  else {
    const tgt = got.targetHtml.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
    ok = tgt.includes(c.target.replace(/\s+/g, "")) && !/^A\d/.test(c.target) === !/^A\d/.test(tgt) && got.exit === c.exit;
    if (ok && c.roads[0] && c.target !== c.roads[0][0] && tgt.includes(c.roads[0][0])) ok = false; // never the motorway you leave
  }
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}\n      row: ${JSON.stringify(got.text)} exit ${JSON.stringify(got.exit)}${c.skipTo != null ? ` next turn at ${got.km}` : ""}`);
}
await browser.close();
console.log(failed ? `${failed} of ${CASES.length} failed` : `all ${CASES.length} passed`);
process.exit(failed ? 1 : 0);
