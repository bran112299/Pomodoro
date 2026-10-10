import { contextBridge, ipcRenderer } from "electron";
import type { PtuApi, UiState } from "../shared/api.js";

const call =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`ptu:${name}`, ...args);

const api: PtuApi = {
  getState: call("getState") as PtuApi["getState"],
  onState: (cb) => {
    const listener = (_e: unknown, s: UiState) => cb(s);
    ipcRenderer.on("ptu:state", listener);
    return () => ipcRenderer.removeListener("ptu:state", listener);
  },
  updateConfig: call("updateConfig") as PtuApi["updateConfig"],
  updateSettings: call("updateSettings") as PtuApi["updateSettings"],
  setDeviceName: call("setDeviceName") as PtuApi["setDeviceName"],
  emergency: call("emergency") as PtuApi["emergency"],
  getStudyData: call("getStudyData") as PtuApi["getStudyData"],
  addReview: call("addReview") as PtuApi["addReview"],
  importDeck: call("importDeck") as PtuApi["importDeck"],
  deleteDeck: call("deleteDeck") as PtuApi["deleteDeck"],
  proveFocus: call("proveFocus") as PtuApi["proveFocus"],
  provePhoto: call("provePhoto") as PtuApi["provePhoto"],
  setReferencePhotos: call("setReferencePhotos") as PtuApi["setReferencePhotos"],
  startPairing: call("startPairing") as PtuApi["startPairing"],
  cancelPairing: call("cancelPairing") as PtuApi["cancelPairing"],
  discover: call("discover") as PtuApi["discover"],
  pairWith: call("pairWith") as PtuApi["pairWith"],
  removePeer: call("removePeer") as PtuApi["removePeer"],
  syncNow: call("syncNow") as PtuApi["syncNow"],
  essentialsMode: call("essentialsMode") as PtuApi["essentialsMode"],
  showLockScreen: call("showLockScreen") as PtuApi["showLockScreen"],
  showDashboard: call("showDashboard") as PtuApi["showDashboard"],
};

contextBridge.exposeInMainWorld("ptu", api);
