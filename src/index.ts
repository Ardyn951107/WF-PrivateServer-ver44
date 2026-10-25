import { config, configPath, loadConfig } from "./services/configService.ts";
import fs from "fs";
import { initLogger, logger } from "./utils/logger.ts";
import mongoose from "mongoose";
import path from "path";
import child_process from "child_process";
import { JSONStringify } from "json-with-bigint";
import { startWebServer, type IListenError } from "./services/webService.ts";
import { syncConfigWithDatabase, validateConfig } from "./services/configWatcherService.ts";
import { updateWorldStateCollections } from "./services/worldStateService.ts";
import { repoDir } from "./helpers/pathHelper.ts";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import type { MongoInstanceEvents } from "mongodb-memory-server-core/lib/util/MongoInstance.js";
import { args } from "./helpers/commandLineArguments.ts";
import { runSelfTests } from "./services/selfTestService.ts";
import customBuild from "./constants/customBuild.ts";
import { getConfiguredMaxBuildLabel } from "./services/clientCompatibilityService.ts";

try {
    loadConfig();
} catch (e) {
    if (fs.existsSync("config.json")) {
        console.log("Failed to load " + configPath + ": " + (e as Error).message);
    } else {
        console.log("Failed to load " + configPath + ". You can copy config-vanilla.json to create your config file.");
    }
    process.exit(1);
}

initLogger(); // depends on config

logger.info(
    `${customBuild.name} ${customBuild.version} targeting Warframe ${customBuild.targetGameVersion}; client ceiling ${getConfiguredMaxBuildLabel() ?? "disabled"}`
);

JSON.stringify = JSONStringify; // Patch JSON.stringify to work flawlessly with Bigints.

validateConfig(); // depends on logger

fs.readFile(path.join(repoDir, "BUILD_DATE"), "utf-8", (err, data) => {
    if (!err) {
        logger.info(`Docker image was built on ${data.trim()}`);
    }
});

if (args.test) {
    const allGood = runSelfTests();
    logger.info(`Self-tests finished`);
    process.exit(allGood ? 0 : 1);
} else {
    let mongodUri = config.database;
    let embeddedMongo: MongoMemoryServer | undefined;
    let shutdownRequested = false;
    let embeddedMongoExpectedStop = false;
    const mongoRuntimeLogPath = path.resolve("logs", "mongod-runtime.log");

    const appendMongoRuntimeLog = (message: unknown): void => {
        try {
            fs.mkdirSync(path.dirname(mongoRuntimeLogPath), { recursive: true });
            const text = Buffer.isBuffer(message) ? message.toString("utf8") : String(message);
            fs.appendFileSync(
                mongoRuntimeLogPath,
                `[${new Date().toISOString()}] ${text.replace(/\r?\n$/, "")}\n`,
                "utf8"
            );
        } catch {
            // Database diagnostics must never become a second failure path.
        }
    };

    const gracefulShutdown = async (reason: string, exitCode = 0): Promise<void> => {
        if (shutdownRequested) {
            return;
        }
        shutdownRequested = true;
        logger.info(`Shutdown requested (${reason}); closing MongoDB cleanly`);

        try {
            await mongoose.disconnect();
        } catch (error) {
            logger.warn(`MongoDB disconnect during shutdown failed: ${(error as Error).message}`);
        }

        if (embeddedMongo) {
            embeddedMongoExpectedStop = true;
            try {
                await embeddedMongo.stop({ doCleanup: false });
            } catch (error) {
                logger.warn(`Embedded MongoDB shutdown failed: ${(error as Error).message}`);
            }
        }

        process.exit(exitCode);
    };

    process.once("SIGINT", () => {
        void gracefulShutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
        void gracefulShutdown("SIGTERM");
    });

    if (typeof mongodUri != "string") {
        const dataDir = path.resolve(mongodUri.dbPath);
        fs.mkdirSync(dataDir, { recursive: true });

        const downloadDir = "node_modules/.cache";

        // Breaking MongoMemoryServer is as easy as pressing Ctrl+C while it's extracting and it has no "cache integrity checking" of its own (https://github.com/typegoose/mongodb-memory-server/issues/991)
        if (fs.existsSync(`${downloadDir}/mongod-x64-win32-7.0.34.exe`)) {
            if (fs.statSync(`${downloadDir}/mongod-x64-win32-7.0.34.exe`).size != 65191936) {
                logger.debug(`${downloadDir}/mongod-x64-win32-7.0.34.exe has invalid size, deleting it`);
                fs.unlinkSync(`${downloadDir}/mongod-x64-win32-7.0.34.exe`);
            }
        }

        embeddedMongo = await MongoMemoryServer.create({
            binary: {
                version: mongodUri.engine == "MongoDB 8.0" ? undefined : "7.0.34", // Check https://www.mongodb.com/docs/v7.0/release-notes/7.0/ for updates :)
                downloadDir
            },
            instance: {
                dbPath: dataDir,
                port: 27117, // Prefer 27117 just to have a steady port for Compass, etc.
                portGeneration: true, // If 27117 is not available, another port is fine.
                launchTimeout: 60_000,
                // The 2026-10-19 crash (exit code 14) was mongod's FTDC thread failing to write diagnostic.data
                // while Windows had no commit memory left ("The paging file is too small"). FTDC is only needed for
                // MongoDB support tickets, and an uncaught FTDC error kills the whole process, so switch it off.
                // The WiredTiger cache is capped so mongod stays small next to the game.
                args: ["--setParameter", "diagnosticDataCollectionEnabled=false", "--wiredTigerCacheSizeGB", "0.5"]
            }
        });
        const mongoInstance = embeddedMongo.instanceInfo?.instance;
        if (mongoInstance) {
            mongoInstance.on("instanceSTDOUT" as MongoInstanceEvents, appendMongoRuntimeLog);
            mongoInstance.on("instanceSTDERR" as MongoInstanceEvents, appendMongoRuntimeLog);
            mongoInstance.on("instanceError" as MongoInstanceEvents, error => {
                appendMongoRuntimeLog(`INSTANCE ERROR: ${String(error)}`);
                logger.error(`Embedded MongoDB instance error: ${String(error)}`);
            });
            mongoInstance.on("instanceClosed" as MongoInstanceEvents, (code, signal) => {
                appendMongoRuntimeLog(`INSTANCE CLOSED: code=${String(code)} signal=${String(signal)}`);
                if (!embeddedMongoExpectedStop && !shutdownRequested) {
                    logger.error(
                        `Embedded MongoDB exited unexpectedly (code=${String(code)}, signal=${String(signal)}). ` +
                            `See ${mongoRuntimeLogPath}`
                    );
                    // Once mongod is gone, keeping the HTTP server alive only produces repeated ECONNRESET errors.
                    // Exit cleanly so the real Mongo failure remains visible in the log and the server can be restarted.
                    setTimeout(() => process.exit(1), 250).unref();
                }
            });
        }

        mongodUri = embeddedMongo.getUri();
        logger.info(`MongoDB server running at ${mongodUri}`);
        logger.info(`MongoDB runtime diagnostics: ${mongoRuntimeLogPath}`);
        mongodUri += "openWF";
    }

    mongoose.connection.on("error", error => {
        logger.error(`MongoDB connection error: ${(error as Error).message}`);
    });
    mongoose.connection.on("disconnected", () => {
        if (!shutdownRequested) {
            logger.warn("MongoDB connection lost; the driver will attempt to reconnect while mongod remains available");
        }
    });
    mongoose.connection.on("reconnected", () => {
        logger.info("MongoDB connection re-established");
    });

    try {
        await mongoose.connect(mongodUri, {
            serverSelectionTimeoutMS: 10_000,
            connectTimeoutMS: 10_000,
            heartbeatFrequencyMS: 5_000
        });
    } catch (error) {
        if (error instanceof Error) {
            logger.error(`Error connecting to MongoDB server: ${error.message}`);
        }
        process.exit(1);
    }
    const mongodbBuildInfo = await mongoose.connection.db!.admin().buildInfo();
    if (
        Array.isArray(mongodbBuildInfo.versionArray) &&
        mongodbBuildInfo.versionArray.every(x => typeof x == "number")
    ) {
        const [major, minor, patch] = mongodbBuildInfo.versionArray;
        logger.info(`Connected to MongoDB v${major}.${minor}.${patch}`);
    } else {
        logger.info("Connected to MongoDB (version unknown)");
    }
    syncConfigWithDatabase();

    try {
        await startWebServer();
    } catch (_err) {
        const err = _err as IListenError;
        if (err.port) {
            logger.error(`Failed to bind port ${err.port}`);
            if (process.platform == "win32") {
                logger.error(
                    `You can check who has that port via powershell: Get-Process -Id (Get-NetTCPConnection -LocalPort ${err.port}).OwningProcess`
                );
            }
        } else {
            logger.error(err.message);
        }
        process.exit(1);
    }

    for (const [what, key] of [
        ["IRC", "ircExecutable"],
        ["HUB", "hubExecutable"]
    ] as const) {
        if (config[key]) {
            logger.info(`Starting ${what}: ${config[key]}`);
            child_process.execFile(config[key], (error, _stdout, _stderr) => {
                if (error) {
                    logger.warn(`Failed to start ${what} server`, error);
                } else {
                    logger.warn(`${what} server terminated unexpectedly`);
                }
            });
        }
    }

    if (args.dev) {
        logger.info(
            "Developer mode is enabled. Note that this project is where it is now due to code contributions; please pay it forward with pull requests."
        );
        runSelfTests();
    }

    const refreshWorldStateSafely = async (source: string): Promise<void> => {
        try {
            await updateWorldStateCollections();
        } catch (error) {
            logger.error(`World-state refresh failed (${source}): ${(error as Error).message}`);
        }
    };

    void refreshWorldStateSafely("startup");
    setInterval(() => {
        void refreshWorldStateSafely("interval");
    }, 60_000);
}
