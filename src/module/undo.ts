
import { debugEnabled, error, log, warn } from "../midi-qol.js";
import { socketlibSocket } from "./GMAction.js";
import { busyWait } from "./tests/setupTest.js";
import { isReactionItem } from "./utils.js";
import { Workflow } from "./workflow.js";

var dae;
Hooks.once("ready", () => {
  dae = globalThis.DAE;
})

export var undoDataQueue: any[] = [];
let startedUndoDataQueue: any[] = [];
const MAXUNDO = 15;
interface undoTokenActorEntry {
  actorUuid: string;
  tokenUuid: string | undefined,
  actorData: any;
  tokenData: any;
}
// Called by workflow to start a new undoWorkflow entry
export async function saveUndoData(workflow: Workflow): Promise<boolean> {
  workflow.undoData = {};
  workflow.undoData.uuid = workflow.uuid;
  workflow.undoData.userId = game.user?.id;
  workflow.undoData.itemName = workflow.item?.name;
  workflow.undoData.itemUuid = workflow.item?.uuid;
  workflow.undoData.userName = game.user?.name;
  workflow.undoData.tokendocUuid = workflow.token.uuid ?? workflow.token.document.uuid;
  workflow.undoData.actorUuid = workflow.actor?.uuid;
  workflow.undoData.actorName = workflow.actor?.name;
  workflow.undoData.chatCardUuids = [];
  workflow.undoData.isReaction = workflow.options?.isReaction || isReactionItem(workflow.item);
  workflow.undoData.concentrationData = {};
  if (!await socketlibSocket.executeAsGM("startUndoWorkflow", workflow.undoData)) {
    error("Could not startUndoWorkflow");
    return false;
  }
  return true;
}

export function createTargetData(tokenUuid) {
  //@ts-expect-error
  const tokendoc = fromUuidSync(tokenUuid);
  const targetData = { tokenUuid, actorUuid: tokendoc?.actor?.uuid, actorData: tokendoc?.actor?.toObject(true), tokenData: tokendoc?.toObject(true) };
  delete targetData.tokenData?.actorData;
  delete targetData.tokenData?.delta;
  return targetData;
}
// Called to save snapshots of workflow actor/token data
export function startUndoWorkflow(undoData: any): boolean {

  //@ts-expect-error fromUuidSync
  let actor = fromUuidSync(undoData.actorUuid);
  if (actor instanceof TokenDocument) actor = actor.actor;
  const actorData = actor?.toObject(true);
  //@ts-expect-error fromUuidSync
  const tokenData = actor?.isToken ? actor.token.toObject(true) : fromUuidSync(undoData.tokendocUuid ?? "")?.toObject(true);
  undoData.actorEntry = { actorUuid: undoData.actorUuid, tokenUuid: undoData.tokendocUuid, actorData, tokenData };
  undoData.allTargets = new Collection; // every token referenced by the workflow
  const actorConcentrationTargets = getProperty(actor, "flags.midi-qol.concentration-data.targets");
  actorConcentrationTargets?.forEach(({ actorUuid, tokenUuid }) => {
    if (actorUuid === undoData.actorUuid) return;
    const targetData = createTargetData(tokenUuid);

    if (!undoData.allTargets.get(actorUuid)) undoData.allTargets.set(actorUuid, targetData)
  });
  addQueueEntry(startedUndoDataQueue, undoData);
  return true;
}

export function updateUndoChatCardUuids(data) {
  const currentUndo = undoDataQueue.find(undoEntry => undoEntry.serverTime === data.serverTime && undoEntry.userId === data.userId);
  if (!currentUndo) {
    console.warn("Could not find existing entry for ", data);
    return;
  }
  currentUndo.chatCardUuids = data.chatCardUuids;
}

// Called after preamblecomplete so save references to all targets
export async function saveTargetsUndoData(workflow: Workflow) {
  workflow.undoData.targets = [];
  workflow.targets.forEach(t => {
    let tokendoc: TokenDocument = (t instanceof TokenDocument) ? t : t.document;
    if (tokendoc.actor?.uuid === workflow.actor.uuid) return;
    workflow.undoData.targets.push({ tokenUuid: tokendoc.uuid, actorUuid: tokendoc.actor?.uuid });
  });
  workflow.undoData.serverTime = game.time.serverTime;
  workflow.undoData.itemCardId = workflow.itemCardId;
  return socketlibSocket.executeAsGM("queueUndoData", workflow.undoData)
}

Hooks.on("createChatMessage", (message, data, options, user) => {
  if ((undoDataQueue ?? []).length < 1) return;
  const currentUndo = undoDataQueue[0];
  const speaker = message.speaker;
  // if (currentUndo.userId !== user) return;
  if (speaker.token) {
    const tokenUuid = `Scene.${speaker.scene}.Token.${speaker.token}`;
    if (currentUndo.allTargets.has(tokenUuid)) currentUndo.chatCardUuids.push(message.uuid);
  } else if (speaker.actor) {
    const actorUuid = `Actor.${speaker.actor}`;
    if (currentUndo.allTargets.has(actorUuid)) currentUndo.chatCardUuids.push(message.uuid);
  }
});

export function showUndoQueue() {
  console.log(undoDataQueue);
  log("Undo queue size is ", new TextEncoder().encode(JSON.stringify(undoDataQueue)).length);
  log("Started queue size is ", new TextEncoder().encode(JSON.stringify(startedUndoDataQueue)).length);
}

export function getUndoQueue() {
  return undoDataQueue;
}

export function queueUndoData(data: any): boolean {
  let inProgress = startedUndoDataQueue.find(undoData => undoData.userId === data.userId && undoData.uuid === data.uuid);
  if (!inProgress) {
    error("Could not find started undo entry for ", data.userId, data.uuid);
    return false;
  };
  inProgress = mergeObject(inProgress, data, { overwrite: false });
  startedUndoDataQueue = startedUndoDataQueue.filter(undoData => undoData.userId !== data.userId || undoData.itemUuid !== data.itemUuid);

  data.targets.forEach(undoEntry => {
    if (!inProgress.allTargets.get(undoEntry.actorUuid)) {
      const targetData = createTargetData(undoEntry.tokenUuid)
      mergeObject(undoEntry, targetData, {inplace: true});
      inProgress.allTargets.set(undoEntry.actorUuid, undoEntry);
    }
    //@ts-expect-error
    let actor = fromUuidSync(undoEntry.actorUuid);
    if (actor instanceof TokenDocument) actor = actor.actor;
    const concentrationTargets = getProperty(actor ?? {}, "flags.midi-qol.concentration-data")?.targets;;
    concentrationTargets?.forEach(({ actorUuid, tokenUuid }) => {
      const targetData = createTargetData(tokenUuid)
      if (!inProgress.allTargets.get(actorUuid)) {
        inProgress.allTargets.set(actorUuid, targetData)
      }
    });
  });

  addQueueEntry(undoDataQueue, inProgress);
  return true;
}

export function addQueueEntry(queue: any[], data: any) {
  // add the item
  let added = false;
  for (let i = 0; i < queue.length; i++) {
    if (data.serverTime > queue[i].serverTime) {
      queue.splice(i, 0, data);
      added = true;
      break;
    }
  }
  if (!added) queue.push(data);
  Hooks.callAll("midi-qol.addUndoEntry", data)
  if (queue.length > MAXUNDO) {
    log("Removed undoEntry due to overflow", queue.pop());
  }
}

export async function undoMostRecentWorkflow() {
  return socketlibSocket.executeAsGM("undoMostRecentWorkflow")
}
export async function removeMostRecentWorkflow() {
  return socketlibSocket.executeAsGM("removeMostRecentWorkflow")
}
export async function _undoMostRecentWorkflow() {
  if (undoDataQueue.length === 0) return false;
  let undoData;
  try {
    while (undoDataQueue.length > 0) {
      undoData = undoDataQueue.shift();
      if (undoData.isReaction) await undoWorkflow(undoData);
      else return undoWorkflow(undoData);
    }
  } finally {
    if (undoData)Hooks.callAll("midi-qol.removeUndoEntry", undoData);
  }
  return;
}

export async function _removeMostRecentWorkflow() {
  if (undoDataQueue.length === 0) return false;
  let undoData;
  try {
    while (undoDataQueue.length > 0) {
      let undoData = undoDataQueue.shift();
      if (undoData.isReaction) continue;
      else return undoData;
    }
  } finally {
    if (undoData) Hooks.callAll("midi-qol.removeUndoEntry", undoData);
  }
  return;
}
export function _removeChatCards(data: { chatCardUuids: string[] }) {
  // TODO see if this might be async and awaited
  if (!data.chatCardUuids) return;
  try {
    for (let uuid of data.chatCardUuids) {
      //@ts-expect-error fromUuidSync
      fromUuidSync(uuid)?.delete();
    }
  } catch (err) {
    debugger;
  }
}

export function getRemoveUndoEffects(effectsData, actor): string[] {
  if (!effectsData) return []; // should only hapoen for unlinked unmodified
  const effectsToRemove = actor.effects.filter(effect => {
    return !effectsData.some(effectData => effect.id === effectData._id);
  }).map(effect => effect.id) ?? [];
  return effectsToRemove;
}

function getRemoveUndoItems(itemsData, actor): string[] {
  if (!itemsData) return []; // Should only happen for unchanged unlinked actors
  const itemsToRemove = actor.items.filter(item => {
    return !itemsData?.some(itemData => item.id === itemData._id);
  }).map(item => item.id);
  return itemsToRemove;
}

function getChanges(newData, savedData): any {
  if (!newData && !savedData) return {};
  delete newData.items;
  delete newData.effects;
  delete savedData.items;
  delete savedData.effects;

  const changes = flattenObject(diffObject(newData, savedData));
  const tempChanges = flattenObject(diffObject(savedData, newData));
  const toDelete = {};
  for (let key of Object.keys(tempChanges)) {
    if (!changes[key]) {
      let parts = key.split(".");
      parts[parts.length - 1] = "-=" + parts[parts.length - 1];
      let newKey = parts.join(".");
      toDelete[newKey] = null
    }
  }
  return mergeObject(changes, toDelete);
}
async function undoSingleTokenActor({ tokenUuid, actorUuid, actorData, tokenData }) {
  //@ts-expect-error
  let actor = fromUuidSync(actorUuid ?? "");
  if (actor instanceof TokenDocument) actor = actor.actor;
  //@ts-expect-error fromuuidSync
  const tokendoc = actor?.isToken ? actor.token : fromUuidSync(tokenUuid ?? "");
  if (!actor) return;
  let actorChanges;
  let tokenChanges;
  if (debugEnabled > 0) warn("undoSingleActor: starting for ", actor.name);

  const removeItemsFunc = async () => {
    const itemsToRemove = getRemoveUndoItems(actorData.items ?? [], actor);
    if (itemsToRemove?.length > 0) await actor.deleteEmbeddedDocuments("Item", itemsToRemove, {isUndo: true});
    if (debugEnabled > 0) warn("removeItemsFunc: items to remove ", actor.name, itemsToRemove);
    // await busyWait(0.1);
  }
  if (dae.actionQueue) await dae.actionQueue.add(removeItemsFunc)
  else await removeItemsFunc();
  if (debugEnabled > 0) warn("undoSingleTokenActor: removeItemFunc completed")

  if (debugEnabled > 0) warn("undoSingleActor: about to remove effects")
  const removeEffectsFunc = async () => {
    const effectsToRemove = getRemoveUndoEffects(actorData.effects ?? [], actor);
    if (debugEnabled > 0) warn("effectsToRemoveFunc ", effectsToRemove);
    if (effectsToRemove.length > 0) await actor.deleteEmbeddedDocuments("ActiveEffect", effectsToRemove, { noConcentrationCheck: true, isUndo: true });
  }
  if (dae?.actionQueue) await dae.actionQueue.add(removeEffectsFunc)
  else await removeEffectsFunc();
  if (debugEnabled > 0) warn("UndoSingleActor: remove effects completed")

  const itemsToAdd = actorData?.items?.filter(itemData => /*!itemData.flags?.dae?.DAECreated && */ !actor.items.some(item => itemData._id === item.id));
  if (debugEnabled > 0) warn("Items to add ", actor.name, itemsToAdd)
  if (itemsToAdd?.length > 0) {
    if (dae?.actionQueue) await dae.actionQueue.add(actor.createEmbeddedDocuments.bind(actor), "Item", itemsToAdd, { keepId: true, isUndo: true });
    else await actor?.createEmbeddedDocuments("Item", itemsToAdd, { keepId: true, isUndo: true });
    await busyWait(0.1);
  }
  let effectsToAdd = actorData?.effects?.filter(efData => !actor.effects.some(effect => efData._id === effect.id));
  if (debugEnabled > 0) warn("Effects to add ", actor.name, effectsToAdd);
  if (effectsToAdd?.length > 0) {
    if (dae?.actionQueue) dae.actionQueue.add(async () => {
      effectsToAdd = effectsToAdd.filter(efId => !actor.effects.some(effect => effect.id === efId))
      if (debugEnabled > 0) warn("Effects to add are ", effectsToAdd, actor.name)
      await actor.createEmbeddedDocuments("ActiveEffect", effectsToAdd, { keepId: true, isUndo: true })
    });
    else await actor.createEmbeddedDocuments("ActiveEffect", effectsToAdd, { keepId: true, isUndo: true });
  }
  actorChanges = actorData ? getChanges(actor.toObject(true), actorData) : {};
  if (debugEnabled > 0) warn("Actor data ", actor.name, actorData, actorChanges);
  //@ts-expect-error isEmpty
  if (!isEmpty(actorChanges)) {
    delete actorChanges.items;
    delete actorChanges.effects;
    await actor.update(actorChanges, { noConcentrationCheck: true })
  }
  if (tokendoc) {
    tokenChanges = tokenData ? getChanges(tokendoc.toObject(true), tokenData) : {};
    delete tokenChanges.actorData;
    delete tokenChanges.delta;
    //@ts-expect-error tokenChanges
    if (!isEmpty(tokenChanges)) {
      await tokendoc.update(tokenChanges, { noConcentrationCheck: true })
    }
  }
}

export async function undoWorkflow(undoData: any) {
  log(`Undoing workflow for Player ${undoData.userName} Token: ${undoData.actorEntry.actorData.name} Item: ${undoData.itemName ?? ""}`)
  for (let undoEntry of undoData.allTargets) {
    log("undoing target ", undoEntry.actorData?.name ?? undoEntry.tokenData?.name, undoEntry)
    await undoSingleTokenActor(undoEntry)
  };
  await undoSingleTokenActor(undoData.actorEntry);
  // delete cards...
  if (undoData.itemCardId) await game.messages?.get(undoData.itemCardId)?.delete();
  _removeChatCards({ chatCardUuids: undoData.chatCardUuids });
}