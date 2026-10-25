// ship-features.mjs  -  list / add Orbiter ship features in the SpaceNinjaServer database.
//
// The server must be RUNNING (the embedded MongoDB only exists while it runs).
//   node ship-features.mjs                  -> list what each account has / is missing (changes nothing)
//   node ship-features.mjs --apply          -> add every missing core feature (not Railjack hull parts)
//   node ship-features.mjs --apply --only VoidProjectionFeatureItem   -> add just that one
//   node ship-features.mjs --uri mongodb://127.0.0.1:PORT/openWF      -> if mongod isn't on 27117
// Then restart the game (or relog) so it re-fetches the ship.
import { MongoClient } from "mongodb";
import fs from "fs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const val = n => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const only = val("--only");
let uri = val("--uri");

if (!uri) {
    // Prefer the port the server logged most recently, fall back to 27117.
    uri = "mongodb://127.0.0.1:27117/openWF";
    try {
        const log = fs
            .readdirSync("logs")
            .filter(f => f.startsWith("trace.log"))
            .sort()
            .pop();
        const m = [...fs.readFileSync("logs/" + log, "utf8").matchAll(/MongoDB server running at (mongodb:\/\/[^\s]+)/g)].pop();
        if (m) uri = m[1].replace(/\/?$/, "/") + "openWF";
    } catch {}
}
console.log("Connecting to", uri);

const PREFIX = "/Lotus/Types/Items/ShipFeatureItems/";
const CORE = [
    "AdvancedOrdisFeatureItem", "AlchemyRoomFeatureItem", "AlertsFeatureItem", "ArsenalFeatureItem",
    "ArsenalMeleeFeatureItem", "CeresNavigationFeatureItem", "ClanFeatureItem", "EarthNavigationFeatureItem",
    "ErisNavigationFeatureItem", "EuropaNavigationFeatureItem", "FoundryConcurrentBuildFormaFeatureItem",
    "FoundryFeatureItem", "FoundryVesselUpgradeFeatureItem", "GeneticFoundryCatbrowUpgradeFeatureItem",
    "GeneticFoundryFeatureItem", "GeneticFoundryUpgradeFeatureItem", "InfestedFoundryArchonShardFeatureItem",
    "InfestedFoundryArchonShardUpgradeFeatureItem", "InfestedFoundryItem", "InfestedFoundryUpgradeFeatureItem",
    "JupiterNavigationFeatureItem", "MarketTierOneFeatureItem", "MarketTierTwoFeatureItem", "MarsNavigationFeatureItem",
    "MercuryNavigationFeatureItem", "ModsFeatureItem", "ModsFusionFeatureItem", "ModsTransmuteFeatureItem",
    "NeptuneNavigationFeatureItem", "PersonalQuartersFeatureItem", "PhobosNavigationFeatureItem",
    "PlutoNavigationFeatureItem", "RailjackCephalonShipFeatureItem", "RailjackKeyShipFeatureItem",
    "SaturnNavigationFeatureItem", "SednaNavigationFeatureItem", "SocialMenuFeatureItem", "SolarChartFeatureItem",
    "UranusNavigationFeatureItem", "VenusNavigationFeatureItem", "VoidProjectionFeatureItem"
].map(x => PREFIX + x);

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
    await client.connect();
} catch (e) {
    console.error("Could not connect. Is the server running? (" + e.message + ")");
    process.exit(1);
}
const db = client.db();
const names = (await db.listCollections().toArray()).map(c => c.name);
const colName = names.find(n => /^personalrooms$/i.test(n));
if (!colName) {
    console.error("No personalrooms collection. Collections:", names.join(", "));
    process.exit(1);
}
const col = db.collection(colName);
const wanted = only ? CORE.filter(x => x.endsWith(only) || x === only) : CORE;
if (only && wanted.length === 0) {
    console.error("--only didn't match a known feature.");
    process.exit(1);
}

for (const doc of await col.find({}).toArray()) {
    const have = doc.Ship?.Features ?? [];
    const missing = wanted.filter(x => !have.includes(x));
    console.log(`\nAccount ${doc.personalRoomsOwnerId}`);
    console.log(`  has ${have.length} feature(s):`);
    for (const h of have) console.log("    + " + h.replace(PREFIX, ""));
    console.log(`  missing ${missing.length}:`);
    for (const m of missing) console.log("    - " + m.replace(PREFIX, ""));
    if (apply && missing.length) {
        const r = await col.updateOne({ _id: doc._id }, { $addToSet: { "Ship.Features": { $each: missing } } });
        console.log(`  >>> added ${missing.length} (modified=${r.modifiedCount}). Restart the game to see it.`);
    }
}
if (!apply) console.log("\n(dry run - nothing changed. Add --apply to add the missing ones.)");
await client.close();
