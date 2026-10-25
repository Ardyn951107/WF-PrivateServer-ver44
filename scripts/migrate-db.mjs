// Merge accounts (and everything linked to them) from one SpaceNinjaServer embedded database into another.
//
//   node scripts/migrate-db.mjs --from "D:\Development\GitHub\SpaceNinjaServer U44-Test\database"
//   node scripts/migrate-db.mjs --from "<other>\database" --apply
//
// Default is a DRY RUN: both databases are opened as temporary copies and nothing on disk is changed.
// --apply   : back up the target database folder first, then merge into it.
// --to DIR  : target database folder (default: dbPath from ./config.json, else ./database).
// --emails a@x.com,b@y.com : only migrate those accounts and the documents that reference them
//             (clan/guild data is NOT copied in this mode).
// --overwrite : replace documents that already exist in the target (same _id) instead of skipping them.
//
// Stop BOTH servers (and any mongod using these folders) before running.
import fs from "fs";
import os from "os";
import path from "path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server-core";

const argv = process.argv.slice(2);
const opt = name => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const flag = name => argv.includes(name);

let engine = "MongoDB 7.0";
let defaultTo = "./database";
try {
    const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
    if (cfg.database && typeof cfg.database == "object") {
        engine = cfg.database.engine ?? engine;
        defaultTo = cfg.database.dbPath ?? defaultTo;
    }
} catch {
    /* use defaults */
}

const fromDir = opt("--from") && path.resolve(opt("--from"));
const toDir = path.resolve(opt("--to") ?? defaultTo);
const apply = flag("--apply");
const overwrite = flag("--overwrite");
const emails = opt("--emails")
    ?.split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
const DB_NAME = "openWF";

if (!fromDir) {
    console.error('Usage: node scripts/migrate-db.mjs --from "<source database folder>" [--to <dir>] [--emails a,b] [--overwrite] [--apply]');
    process.exit(2);
}
if (!fs.existsSync(fromDir) || !fs.existsSync(toDir)) {
    console.error(`Folder not found: ${!fs.existsSync(fromDir) ? fromDir : toDir}`);
    process.exit(2);
}
if (fromDir.toLowerCase() == toDir.toLowerCase()) {
    console.error("--from and --to are the same folder.");
    process.exit(2);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snmig-"));
const copyDb = (dir, name) => {
    const dest = path.join(tmpRoot, name);
    fs.cpSync(dir, dest, { recursive: true });
    fs.rmSync(path.join(dest, "mongod.lock"), { force: true });
    return dest;
};

const open = async dbPath => {
    const server = await MongoMemoryServer.create({
        binary: { version: engine == "MongoDB 8.0" ? undefined : "7.0.34", downloadDir: "node_modules/.cache" },
        instance: { dbPath, portGeneration: true, launchTimeout: 60_000 }
    });
    const client = new mongoose.mongo.MongoClient(server.getUri());
    await client.connect();
    return {
        db: client.db(DB_NAME),
        close: async () => {
            await client.close();
            await server.stop({ doCleanup: false });
        }
    };
};

const sameId = (a, b) => a != null && b != null && String(a) == String(b);

const main = async () => {
    console.log(apply ? "MODE: APPLY" : "MODE: dry run (nothing will be written)");
    console.log(`Source: ${fromDir}\nTarget: ${toDir}\n`);

    let backupDir;
    let targetPath;
    if (apply) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        backupDir = `${toDir}_BACKUP_${stamp}`;
        console.log(`Backing up target to ${backupDir} ...`);
        fs.cpSync(toDir, backupDir, { recursive: true });
        targetPath = toDir;
    } else {
        targetPath = copyDb(toDir, "target");
    }
    const source = await open(copyDb(fromDir, "source"));
    const target = await open(targetPath);

    try {
        const srcAccounts = await source.db.collection("accounts").find({}).toArray();
        const dstAccounts = await target.db.collection("accounts").find({}).toArray();
        console.log(`Accounts: source ${srcAccounts.length}, target ${dstAccounts.length}`);

        const dstByEmail = new Map(dstAccounts.map(a => [String(a.email).toLowerCase(), a]));
        const dstById = new Set(dstAccounts.map(a => String(a._id)));
        const selected = [];
        const skippedIds = new Set(); // source accounts that must not be migrated (email clash)
        for (const a of srcAccounts) {
            const email = String(a.email).toLowerCase();
            if (emails && !emails.includes(email)) {
                skippedIds.add(String(a._id));
                continue;
            }
            const clash = dstByEmail.get(email);
            if (clash && !sameId(clash._id, a._id)) {
                skippedIds.add(String(a._id));
                console.log(`  CONFLICT  ${a.email}: exists in target with a different _id (${clash._id} vs ${a._id}) -> skipped`);
            } else if (dstById.has(String(a._id))) {
                console.log(`  exists    ${a.email} (${a._id})${overwrite ? " -> will be overwritten" : " -> kept as is"}`);
                selected.push(a);
            } else {
                console.log(`  NEW       ${a.email} (${a._id}) ${a.DisplayName ?? ""}`);
                selected.push(a);
            }
        }
        const selectedIds = new Set(selected.map(a => String(a._id)));

        const stats = [];
        const collections = (await source.db.listCollections({}, { nameOnly: true }).toArray())
            .map(c => c.name)
            .filter(n => !n.startsWith("system."));
        for (const name of collections) {
            const src = source.db.collection(name);
            const dst = target.db.collection(name);
            let docs = await src.find({}).toArray();

            if (name == "accounts") {
                docs = selected;
            } else if (emails) {
                // Subset mode: only documents that reference a selected account
                docs = docs.filter(d => Object.values(d).some(v => selectedIds.has(String(v))));
            } else {
                // Full mode: drop anything belonging to an account we refused to migrate
                docs = docs.filter(d => !Object.values(d).some(v => skippedIds.has(String(v))));
            }

            let inserted = 0;
            let present = 0;
            let failed = 0;
            const errors = [];
            for (const doc of docs) {
                const d = { ...doc };
                if (name == "accounts" && d.Nonce) {
                    d.Nonce = 0; // avoid "nonce still set" at first login
                }
                const exists = await dst.findOne({ _id: d._id }, { projection: { _id: 1 } });
                if (exists && !overwrite) {
                    present++;
                    continue;
                }
                if (!apply) {
                    inserted++;
                    continue;
                }
                try {
                    if (exists) {
                        await dst.replaceOne({ _id: d._id }, d);
                    } else {
                        await dst.insertOne(d);
                    }
                    inserted++;
                } catch (e) {
                    failed++;
                    if (errors.length < 3) errors.push(`${d._id}: ${e.message}`);
                }
            }
            stats.push({ collection: name, source: docs.length, [apply ? "written" : "would write"]: inserted, "already there": present, failed });
            for (const e of errors) console.log(`  ! ${name}: ${e}`);
        }
        console.log("");
        console.table(stats);
        if (apply) {
            console.log(`Done. Backup of the previous target: ${backupDir}`);
        } else {
            console.log("Dry run only. Re-run with --apply to perform the merge.");
        }
    } finally {
        await source.close();
        await target.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
};

main().catch(e => {
    console.error("Migration failed:", e);
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
    process.exit(1);
});
