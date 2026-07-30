"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = __importDefault(require("ws"));
const index_1 = require("./index");
const WS_PORT = Number((_a = process.env.WS_PORT) !== null && _a !== void 0 ? _a : 8080);
const wss = new ws_1.default.Server({ port: WS_PORT });
wss.on("listening", () => {
    console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);
});
wss.on("connection", (ws) => {
    console.log(`WebSocket client connected (total: ${wss.clients.size})`);
    ws.send(JSON.stringify({ event: "connected", message: "Thai ID Card Reader WebSocket ready" }));
    ws.on("close", () => {
        console.log(`WebSocket client disconnected (remaining: ${wss.clients.size})`);
    });
});
function broadcast(payload) {
    const message = JSON.stringify(payload);
    let sent = 0;
    wss.clients.forEach((client) => {
        if (client.readyState === ws_1.default.OPEN) {
            client.send(message);
            sent++;
        }
    });
    console.log(`WebSocket broadcast: event="${payload.event}" → sent to ${sent} client(s)`);
}
run();
function run() {
    const reader = new index_1.ThaiIdCardReader({
        insertCardDelay: 1000,
        readTimeout: 5000,
        maxReadAttempts: 3,
        retryDelayMs: 2000,
        postRemovalSettleMs: 3000,
    });
    console.log("Reader config", { insertCardDelay: 1000, readTimeout: 5000, maxReadAttempts: 3, retryDelayMs: 2000, postRemovalSettleMs: 3000 });
    reader.init();
    reader.onReadComplete((data) => {
        broadcast({ event: "card_read", data });
    });
    reader.onReadError((error) => {
        console.error("Thai ID card read error", error);
        broadcast({ event: "card_error", error });
    });
}
