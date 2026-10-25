import { getInventory } from "../../services/inventoryService.ts";
import { getAccountForRequest, getBuildLabel } from "../../services/loginService.ts";
import { giveKeyChainMessage } from "../../services/questService.ts";
import { logger } from "../../utils/logger.ts";
import type { IKeyChainRequest } from "../../types/requestTypes.ts";
import type { RequestHandler } from "express";

const warnedKeyChains = new Set<string>();

export const giveKeyChainTriggeredMessageController: RequestHandler = async (req, res) => {
    const account = await getAccountForRequest(req);
    const buildLabel = getBuildLabel(req, account);
    const keyChainInfo = JSON.parse((req.body as Buffer).toString()) as IKeyChainRequest;

    const inventory = await getInventory(account._id, "QuestKeys accountOwnerId");
    const questKey = inventory.QuestKeys.find(qk => qk.ItemType === keyChainInfo.KeyChain)!;
    try {
        await giveKeyChainMessage(inventory, keyChainInfo, questKey, true, buildLabel);
        await inventory.save();
    } catch (e) {
        // Key chains that are missing from the export data (e.g. quests newer than warframe-public-export-plus)
        // would otherwise make the client retry every ~30 seconds. Acknowledge them instead.
        if (e instanceof Error && /does not contain chain stages|but they did not exist/.test(e.message)) {
            if (!warnedKeyChains.has(keyChainInfo.KeyChain)) {
                warnedKeyChains.add(keyChainInfo.KeyChain);
                logger.warn(
                    `no key chain message data for ${keyChainInfo.KeyChain} (stage ${keyChainInfo.ChainStage}); acknowledging without sending a message`
                );
            }
        } else {
            throw e;
        }
    }

    res.send(1);
};
