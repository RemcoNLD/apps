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
// [km, type, name, exitNo, angle, flags, prev]: merge onto the A27, exit (slip road named A27), fork, turn.
const NIEUWEGEIN = [[0.5, 1, "Rondweg", 0, 90, "", "De Polder"], [2.0, 12, "A27", 0, -10, "", ""], [4.6, 13, "A27", 0, 15, "", "A27"],
  [5.0, 12, "A27", 0, -10, "", "A27"], [5.4, 13, "", 0, 12, "", "A27"], [7.0, 1, "Jutphaseweg", 0, 90, "", ""]];
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
  // Drive Houten → Makadocenter (28 Nov 09:17, app 0.46): 2.5 km of A27 (under the timeline's 3 km),
  // the map lookup had failed at planning (offline). Showed "1.0 km A27" without a number; the fork on
  // the slip road (keep left, keep right) wasn't mentioned.
  { name: "Nieuwegein, no map roads at all: the steps show the exit", km: 3.6,
    roads: [], exits: [],
    turns: NIEUWEGEIN,
    target: "Jutphaseweg", exit: "", expectKm: 4.6 },
  { name: "Nieuwegein with the map: short A27 stretch kept for turn by turn, exit number", km: 3.6,
    roads: [], turnRoads: [["A27", 2.1, 4.9]], exits: [[4.55, "28", "Nieuwegein-Zuid"]],
    turns: NIEUWEGEIN,
    target: "Jutphaseweg", exit: "28", expectKm: 4.6 },
  { name: "Nieuwegein: 50 m past the exit it still shows the exit", km: 4.65,
    roads: [], turnRoads: [["A27", 2.1, 4.9]], exits: [[4.55, "28", "Nieuwegein-Zuid"]],
    turns: NIEUWEGEIN,
    target: "Jutphaseweg", exit: "28", expectKm: 4.6 },
  { name: "Nieuwegein: on the slip road, keep left is shown, not as A27", km: 4.75,
    roads: [], turnRoads: [["A27", 2.1, 4.9]], exits: [[4.55, "28", "Nieuwegein-Zuid"]],
    turns: NIEUWEGEIN,
    target: "Jutphaseweg", exit: "", expectKm: 5.0 },
  { name: "Nieuwegein: then keep right (no fixes: past the 150 m safety net)", km: 5.2,
    roads: [], turnRoads: [["A27", 2.1, 4.9]], exits: [[4.55, "28", "Nieuwegein-Zuid"]],
    turns: NIEUWEGEIN,
    target: "Jutphaseweg", exit: "", expectKm: 5.4 },
  { name: "Roundabout: still shown inside it (until its exit), no \"1st exit\" text", km: 10.1,
    roads: [], exits: [],
    turns: [[10.0, 7, "Sluyterlaan", 1, 80, "r", "Laan"], [10.15, 6, "Sluyterlaan", 0, 0, "", "Sluyterlaan"], [12, 0, "Kruyderlaan", 0, -90, "", "Sluyterlaan"]],
    target: "Sluyterlaan", exit: "", expectKm: 10.0, noText: "1st" },
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
      exits: c.exits, turns: c.turns, borders: [],
      turnRoads: c.turnRoads ? c.turnRoads.map(([ref, fromKm, toKm]) => ({ ref, country: "NL", fromKm, toKm })) : undefined };
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
    if (ok && c.turnRoads && tgt.includes(c.turnRoads[0][0])) ok = false;
    if (ok && c.expectKm != null && got.km !== c.expectKm) ok = false;
    if (ok && c.noText && got.text.includes(c.noText)) ok = false;
  }
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}\n      row: ${JSON.stringify(got.text)} exit ${JSON.stringify(got.exit)} turn at ${got.km}`);
}
// Passing from movement (0.48.1): a route north 1 km, then a right turn east 1 km. Fixes every 10 m
// (~1 s at 36 km/h) with the heading of travel; the turn at km 1.0 must stop being shown within
// 30 m after the corner, not only after the 150 m safety net. And an exit at a slight angle (keep
// right, 15°) by moving away from its point.
for (const m of [
  { name: "Movement: right turn passed by turning", turn: [1.0, 1, "Oost", 0, 90, "", "Noord"], within: 0.03 },
  { name: "Movement: keep right (15°) passed by moving away", turn: [1.0, 13, "", 0, 15, "", "A27"], within: 0.04 },
]) {
  const got = await page.evaluate((m) => {
    const lat0 = 52, lon0 = 5, dLat = 1 / 111.2, dLon = 1 / (111.2 * Math.cos(52 * Math.PI / 180));
    state.stations = []; state.roadOverride = null;
    state.route = { distanceKm: 2, coords: [[lon0, lat0], [lon0, lat0 + dLat], [lon0 + dLon, lat0 + dLat]], km: [0, 1, 2], min: [0, 1, 2],
      roads: [], exits: [], borders: [], turns: [m.turn, [2, 10, "", 0, 0, "", ""]] };
    state.user = { km: 0, min: 0, offKm: 0, acc: 5, at: Date.now() };
    let gone = null;
    for (let k = 0.5; k <= 1.3; k += 0.01) {
      const p = pointAtKm(k);
      state.user = { ...state.user, km: k, at: Date.now(), lonlat: p };
      state.heading = k < 1.0 ? 0 : 90;
      trackTurnPassing(p, 5);
      const t = nextTurn();
      if (gone == null && (!t || t.km !== 1.0)) gone = k;
    }
    return gone;
  }, m);
  const ok = got != null && got - 1.0 <= m.within + 1e-9 && got > 1.0 - 1e-9;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${m.name}\n      next instruction from km ${got?.toFixed(2)}`);
}
await browser.close();
console.log(failed ? `${failed} of ${CASES.length + 2} failed` : `all ${CASES.length + 2} passed`);
process.exit(failed ? 1 : 0);
