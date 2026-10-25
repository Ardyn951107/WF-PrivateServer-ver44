import type { RequestHandler } from "express";
import { getAccountForRequest, getBuildLabel } from "../../services/loginService.ts";
import { ePurchaseSource } from "../../types/purchaseTypes.ts";
import type { IPurchaseRequest, IPurchaseRequestU16 } from "../../types/purchaseTypes.ts";
import { handlePurchase } from "../../services/purchaseService.ts";
import { getInventory } from "../../services/inventoryService.ts";
import { sendWsBroadcastTo } from "../../services/wsService.ts";
import { toStoreItem } from "../../services/itemDataService.ts";
import { ExportBundles } from "warframe-public-export-plus";
import { version_compare } from "../../helpers/inventoryHelpers.ts";
import gameToBuildVersion from "../../constants/gameToBuildVersion.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Warframe 44.x may prepend a small header object to the request body, e.g.
 * {"ChallengePTS":1791981813,"crossPlaySetting":"ENABLED"}{"PurchaseParams":{...},"buildLabel":"..."}
 * i.e. two JSON values back to back. Split them and use the one that is the actual purchase request.
 */
const splitJsonValues = (text: string): string[] => {
    const values: string[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    for (let i = 0; i < text.length; ++i) {
        const c = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c == "\\") escaped = true;
            else if (c == '"') inString = false;
        } else if (c == '"') {
            inString = true;
        } else if (c == "{" || c == "[") {
            if (depth++ == 0) start = i;
        } else if ((c == "}" || c == "]") && --depth == 0) {
            values.push(text.substring(start, i + 1));
        }
    }
    if (depth != 0 || inString) throw new SyntaxError("Unbalanced JSON in request body");
    return values;
};

const parsePurchaseBody = (text: string): IPurchaseRequest | IPurchaseRequestU16 => {
    try {
        return JSON.parse(text) as IPurchaseRequest | IPurchaseRequestU16;
    } catch (e) {
        const parts = splitJsonValues(text);
        if (parts.length < 2) throw e;
        const objects = parts.map(p => JSON.parse(p) as Record<string, unknown>);
        const real = objects.find(o => "PurchaseParams" in o || "productName" in o);
        if (!real) throw e;
        logger.debug(`purchase.php body had ${parts.length} concatenated JSON values; using the purchase request`);
        return real as unknown as IPurchaseRequest | IPurchaseRequestU16;
    }
};

export const purchasePostController: RequestHandler = async (req, res) => {
    const purchaseRequestText = String(req.body);
    let purchaseRequest: IPurchaseRequest | IPurchaseRequestU16;
    try {
        purchaseRequest = parsePurchaseBody(purchaseRequestText);
    } catch (e) {
        logger.error(
            `purchase.php body failed to parse (${purchaseRequestText.length} chars): ${(e as Error).message}\n` +
                `  text: ${JSON.stringify(purchaseRequestText.slice(0, 1500))}`
        );
        throw e;
    }
    if (!("PurchaseParams" in purchaseRequest)) {
        logger.debug("converting legacy purchase request", purchaseRequest);
        purchaseRequest = {
            PurchaseParams: {
                Source: purchaseRequest.voidTraderId ? ePurchaseSource.VoidTrader : ePurchaseSource.Market,
                SourceId: purchaseRequest.voidTraderId,
                StoreItem: toStoreItem(purchaseRequest.productName),
                Quantity: purchaseRequest.quantity,
                UsePremium: purchaseRequest.usePremium == "1"
            },
            buildLabel: ""
        } satisfies IPurchaseRequest;
    }
    const account = await getAccountForRequest(req);
    if (!purchaseRequest.buildLabel) {
        purchaseRequest.buildLabel = getBuildLabel(req, account);
    }
    const inventory = await getInventory(account._id, undefined);
    const response = await handlePurchase(purchaseRequest, inventory);
    await inventory.save();
    logger.trace("purchase response:", response);
    res.json(response);
    sendWsBroadcastTo(account._id.toString(), { update_inventory: true });
};

export const purchaseGetController: RequestHandler = async (req, res) => {
    const account = await getAccountForRequest(req);
    const accountId = account._id.toString();
    let internalName = String(req.query.productName);
    if (!(internalName in ExportBundles)) internalName = toStoreItem(internalName);
    const purchaseRequest: IPurchaseRequest = {
        PurchaseParams: {
            Source: ePurchaseSource.Market,
            StoreItem: internalName,
            Quantity: 1,
            UsePremium: Boolean(Number(req.query.usePremium))
        },
        buildLabel: getBuildLabel(req, account)
    };
    if (req.query.durability) purchaseRequest.PurchaseParams.Durability = Number(req.query.durability);
    const inventory = await getInventory(accountId, undefined);
    const response = await handlePurchase(purchaseRequest, inventory);
    await inventory.save();
    if (response.Body) {
        let body = response.Body.replace(/\/StoreItems/g, "");
        if (version_compare(purchaseRequest.buildLabel, gameToBuildVersion["8.3.0"]) <= 0) {
            body = body.replace(/lvl=\d+;/g, "");
        }
        res.send(body);
    } else {
        if (version_compare(purchaseRequest.buildLabel, gameToBuildVersion["8.0.0"]) > 0) {
            res.send(String(req.query.productName));
        } else {
            res.json(1);
        }
    }
    sendWsBroadcastTo(accountId, { update_inventory: true });
};
