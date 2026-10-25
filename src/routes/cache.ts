import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "../services/configService.ts";
import { logger } from "../utils/logger.ts";

const cacheRouter = express.Router();

cacheRouter.get(/^\/origin\/[a-zA-Z0-9]+\/[0-9]+\/H\.Cache\.bin.*$/, (_req, res) => {
    res.sendFile(`static/data/H.Cache.bin`, { root: "./" });
});

// Where stripped/content assets may live. The first existing folder is used for reads; downloads from the
// official CDN are saved into the first one too (created if none exist).
const strippedAssetsCandidates = ["static/data/0", "static/data/stripped-assets", "stripped-assets"];
const strippedAssetsDir = strippedAssetsCandidates.find(dir => fs.existsSync(dir)) ?? "static/data/stripped-assets";

// U44 custom: when a /0/... content file is missing locally (e.g. a new hotfix's B.Cache.Windows_en.bin manifest,
// or new ability videos), fetch the exact same file from DE's content CDN, store it and serve it.
// Disable with "proxyMissingContent": false in config.json.
const contentCdn = "https://content.warframe.com";
const proxyMissingContent = (): boolean => (config as { proxyMissingContent?: boolean }).proxyMissingContent !== false;
const inflight = new Map<string, Promise<Buffer | undefined>>();

const fetchFromCdn = (urlPath: string, filePath: string): Promise<Buffer | undefined> => {
    let job = inflight.get(filePath);
    if (!job) {
        job = (async (): Promise<Buffer | undefined> => {
            try {
                const resp = await fetch(contentCdn + urlPath, { signal: AbortSignal.timeout(60_000) });
                if (!resp.ok) {
                    logger.debug(`content CDN ${resp.status} for ${urlPath}`);
                    return undefined;
                }
                const data = Buffer.from(await resp.arrayBuffer());
                await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
                await fs.promises.writeFile(filePath, data);
                logger.info(`fetched ${urlPath} from content CDN (${data.length} bytes) -> ${filePath}`);
                return data;
            } catch (err) {
                logger.warn(`content CDN fetch failed for ${urlPath}: ${(err as Error).message}`);
                return undefined;
            } finally {
                inflight.delete(filePath);
            }
        })();
        inflight.set(filePath, job);
    }
    return job;
};

cacheRouter.get(/^\/0(?:_[a-z]{2})?\/.+!.+$/, async (req, res) => {
    const dir = req.path.substring(0, req.path.lastIndexOf("/"));
    const file = req.path.substring(dir.length + 1);
    const filePath = `${strippedAssetsDir}${dir}/${file}`;
    // refuse path traversal
    if (req.path.includes("..")) {
        res.status(400).end();
        return;
    }
    try {
        // Return file if we have it
        await fs.promises.access(filePath);
        const data = await fs.promises.readFile(filePath, null);
        res.send(data);
        return;
    } catch {
        // not cached locally
    }
    if (proxyMissingContent()) {
        const data = await fetchFromCdn(req.path, filePath);
        if (data) {
            res.send(data);
            return;
        }
    }
    // 404 if we don't
    res.status(404).end();
});

// routes for android and possibly other non-PC platforms
cacheRouter.get(/^\/origin\/[a-zA-Z0-9]+\/index\.txt\.lzma.*$/, (_, res) => {
    res.sendFile(`static/data/content/index.txt.lzma`, { root: "./" });
});

cacheRouter.get(/^\/[0-9]+\/H\.Cache\.bin.*$/, (_req, res) => {
    res.sendFile(`static/data/H.Cache.bin`, { root: "./" });
});

cacheRouter.get(/^(\/\/|\/)(SplitCaches|Lotus|Tools|7|7_en)\/.*$/, async (req, res) => {
    try {
        const dir = req.path.replaceAll("//", "/").substring(0, req.path.lastIndexOf("/"));
        const file = req.path.substring(dir.length + 1);
        const filePath = `static/data/content${dir}/${file}`;
        // Return file if we have it
        await fs.promises.access(filePath);
        const data = await fs.promises.readFile(filePath, null);
        res.send(data);
    } catch (err) {
        // 404 if we don't
        res.status(404).end();
    }
});

export { cacheRouter };
