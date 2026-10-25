const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const checks = [];
const ok = (name, condition, detail = "") => checks.push({ name, condition: Boolean(condition), detail });
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

const pkg = JSON.parse(read("package.json"));
const vanilla = JSON.parse(read("config-vanilla.json"));
const customBuild = read("src/constants/customBuild.ts");
const login = read("src/controllers/api/loginController.ts");
const api = read("src/routes/api.ts");
const inventory = read("src/controllers/api/inventoryController.ts");
const worldState = read("src/services/worldStateService.ts");
const app = read("src/app.ts");
const index = read("src/index.ts");

ok("custom package version", pkg.version.includes("u44.1.1-custom"), pkg.version);
ok("target 44.1.1 declared", customBuild.includes('targetGameVersion: "44.1.1"'));
ok("U44 base build mapping present", read("src/constants/gameToBuildVersion.ts").includes('"44.0.0": "2026.09.22.16.46"'));
ok("configurable client ceiling", vanilla.clientCompatibility?.maxBuildLabel === "2026.10.09.23.59", vanilla.clientCompatibility?.maxBuildLabel);
ok("legacy fixed 43.5.4 gate removed", !login.includes('version_compare(buildLabel, "2026.08.19.11.06")'));
ok("compatibility service wired into login", login.includes("checkClientCompatibility(buildLabel)"));
ok("VesselCustomization v2 path", inventory.includes("VesselCustomization"));
ok("Iceblade endpoint registered", api.includes("iceBladeChallenge.php"));
ok("Kuva Path endpoint registered", api.includes("kuvaPath.php"));
ok("Riven Splicer endpoint registered", api.includes("mergeRandomUpgrades.php"));
ok("U44 world-state logic present", worldState.includes('gameToBuildVersionInt["44.0.0"]'));
ok("raw import body raised to 4mb", app.includes('express.raw({ limit: "4mb" })'));
ok("Mongo startup timeout raised", index.includes("launchTimeout: 60_000"));
ok("graceful Mongo shutdown", index.includes("gracefulShutdown"));
ok("Mongo runtime log", index.includes("mongod-runtime.log"));
ok("safe world-state refresh", index.includes("refreshWorldStateSafely"));

let failed = 0;
for (const c of checks) {
  const mark = c.condition ? "PASS" : "FAIL";
  if (!c.condition) failed++;
  console.log(`${mark.padEnd(4)}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
}
console.log(`\n${checks.length - failed}/${checks.length} U44 custom-build checks passed.`);
process.exitCode = failed ? 1 : 0;
