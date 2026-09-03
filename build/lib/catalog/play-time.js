"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var play_time_exports = {};
__export(play_time_exports, {
  PLAY_TIME_TWINS: () => PLAY_TIME_TWINS,
  formatPlayTime: () => formatPlayTime,
  parsePlayTime: () => parsePlayTime,
  playTimeTwin: () => playTimeTwin,
});
module.exports = __toCommonJS(play_time_exports);
const SECONDS_PER_HOUR = 3600;
function parsePlayTime(text) {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3) {
    return void 0;
  }
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part.trim())) {
      return void 0;
    }
    seconds = seconds * 60 + Number(part.trim());
  }
  return seconds;
}
function formatPlayTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const total = Math.floor(seconds);
  const ss = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  if (total < SECONDS_PER_HOUR) {
    return `${minutes}:${ss}`;
  }
  return `${Math.floor(total / SECONDS_PER_HOUR)}:${String(minutes).padStart(2, "0")}:${ss}`;
}
const PLAY_TIME_TWINS = {
  "player.elapsedTime": "player.elapsedTimeText",
  "player.totalTime": "player.totalTimeText",
};
function playTimeTwin(id, value) {
  const twin = PLAY_TIME_TWINS[id];
  if (twin === void 0) {
    return void 0;
  }
  return { id: twin, value: typeof value === "number" ? formatPlayTime(value) : "" };
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    PLAY_TIME_TWINS,
    formatPlayTime,
    parsePlayTime,
    playTimeTwin,
  });
//# sourceMappingURL=play-time.js.map
