"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = __importDefault(require("events"));
const pcsclite_1 = __importDefault(require("pcsclite"));
const normalize_card_data_1 = require("./reader/normalize-card-data");
const read_card_data_1 = require("./reader/read-card-data");
const delay_1 = require("./utils/delay");
const READ_COMPLETE_EVENT = "READ_COMPLETE";
const READ_ERROR_EVENT = "READ_ERROR";
class ThaiIdCardReader {
    constructor(options = {}) {
        var _a, _b, _c, _d, _e;
        this.readTimeout = 0;
        this.insertCardDelay = 1000;
        this.maxReadAttempts = 3;
        this.retryDelayMs = 2000;
        this.postRemovalSettleMs = 3000;
        this.readingReaders = new Set();
        this.lastRemovedAt = new Map();
        this.pcscInstance = null;
        this.pcscGeneration = 0;
        this.eventEmitter = new events_1.default();
        this.insertCardDelay = (_a = options.insertCardDelay) !== null && _a !== void 0 ? _a : this.insertCardDelay;
        this.readTimeout = (_b = options.readTimeout) !== null && _b !== void 0 ? _b : this.readTimeout;
        this.maxReadAttempts = (_c = options.maxReadAttempts) !== null && _c !== void 0 ? _c : this.maxReadAttempts;
        this.retryDelayMs = (_d = options.retryDelayMs) !== null && _d !== void 0 ? _d : this.retryDelayMs;
        this.postRemovalSettleMs = (_e = options.postRemovalSettleMs) !== null && _e !== void 0 ? _e : this.postRemovalSettleMs;
    }
    setReadTimeout(timeout) {
        this.readTimeout = timeout;
    }
    setInsertCardDelay(timeout) {
        this.insertCardDelay = timeout;
    }
    onReadComplete(callBack) {
        this.eventEmitter.on(READ_COMPLETE_EVENT, (data) => {
            callBack((0, normalize_card_data_1.normalizeCardData)(data));
        });
    }
    onReadError(callBack) {
        this.eventEmitter.on(READ_ERROR_EVENT, (error) => {
            callBack(error);
        });
    }
    init() {
        this.startPCSC();
    }
    startPCSC() {
        if (this.pcscInstance) {
            try {
                this.pcscInstance.close();
            }
            catch (_a) {
                // ignore cleanup errors from stale instance
            }
            this.pcscInstance = null;
        }
        this.pcscGeneration++;
        const generation = this.pcscGeneration;
        console.log("ThaiSmartCardConnector init");
        const pcsc = (0, pcsclite_1.default)();
        this.pcscInstance = pcsc;
        pcsc.on("reader", (reader) => {
            if (this.pcscGeneration !== generation)
                return;
            // Cancel pending re-init — this pcsc context can still detect readers
            if (this.pcscReinitTimer) {
                clearTimeout(this.pcscReinitTimer);
                this.pcscReinitTimer = undefined;
                console.log("Reader detected — PCSC re-init cancelled");
            }
            console.log("New reader detected", reader.name);
            reader.on("error", (err) => {
                console.log("Error(", reader.name, "):", err.message);
            });
            reader.on("status", (status) => __awaiter(this, void 0, void 0, function* () {
                var _a;
                if (this.pcscGeneration !== generation)
                    return;
                const changes = reader.state ^ status.state;
                if (!changes) {
                    return;
                }
                if (changes & reader.SCARD_STATE_EMPTY &&
                    status.state & reader.SCARD_STATE_EMPTY) {
                    console.log("card removed");
                    this.lastRemovedAt.set(reader, Date.now());
                    this.readingReaders.delete(reader);
                    reader.disconnect(reader.SCARD_LEAVE_CARD, (err) => {
                        if (err)
                            console.log("disconnect on removal:", err.message);
                    });
                    return;
                }
                if (changes & reader.SCARD_STATE_PRESENT &&
                    status.state & reader.SCARD_STATE_PRESENT) {
                    if (this.readingReaders.has(reader)) {
                        return;
                    }
                    const removedAt = (_a = this.lastRemovedAt.get(reader)) !== null && _a !== void 0 ? _a : 0;
                    const timeSinceRemoval = Date.now() - removedAt;
                    const settleWait = Math.max(0, this.postRemovalSettleMs - timeSinceRemoval);
                    const totalWait = this.insertCardDelay + settleWait;
                    if (settleWait > 0) {
                        console.log(`card inserted (recent removal detected, settling ${settleWait}ms + ${this.insertCardDelay}ms = ${totalWait}ms)`);
                    }
                    else {
                        console.log(`card inserted (waiting ${this.insertCardDelay}ms)`);
                    }
                    yield (0, delay_1.delay)(totalWait);
                    this.connectAndRead(reader);
                }
            }));
            reader.on("end", () => {
                if (this.pcscGeneration !== generation)
                    return;
                console.log("Reader", reader.name, "removed — scheduling PCSC re-init");
                this.readingReaders.delete(reader);
                this.lastRemovedAt.delete(reader);
                this.schedulePCSCReinit();
            });
        });
        pcsc.on("error", (err) => {
            if (this.pcscGeneration !== generation)
                return;
            console.log("PCSC error", err.message);
            this.eventEmitter.emit(READ_ERROR_EVENT, err.message);
            this.schedulePCSCReinit();
        });
    }
    schedulePCSCReinit(delayMs = 5000) {
        if (this.pcscReinitTimer) {
            clearTimeout(this.pcscReinitTimer);
        }
        console.log(`Will re-init PCSC in ${delayMs}ms to detect reader re-plug...`);
        this.pcscReinitTimer = setTimeout(() => {
            this.pcscReinitTimer = undefined;
            console.log("Re-initializing PCSC context...");
            this.startPCSC();
        }, delayMs);
    }
    connectAndRead(reader, attempt = 1) {
        if (attempt === 1) {
            this.readingReaders.add(reader);
        }
        reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, (connectErr, protocol) => __awaiter(this, void 0, void 0, function* () {
            if (connectErr) {
                console.log(`[Attempt ${attempt}/${this.maxReadAttempts}] Connect error: ${connectErr.message}`);
                if (attempt < this.maxReadAttempts) {
                    yield (0, delay_1.delay)(this.retryDelayMs);
                    this.connectAndRead(reader, attempt + 1);
                }
                else {
                    console.log("Max retry attempts reached — emitting error");
                    this.readingReaders.delete(reader);
                    this.eventEmitter.emit(READ_ERROR_EVENT, connectErr.message);
                }
                return;
            }
            try {
                const sendRawCommand = (0, read_card_data_1.createCommandTransmitter)((command, expected) => this.transmitToCard(reader, protocol, command, expected));
                const data = yield (0, read_card_data_1.readCardData)(sendRawCommand);
                this.eventEmitter.emit(READ_COMPLETE_EVENT, data);
                reader.disconnect(() => {
                    // console.log("Card read complete — reader disconnected")
                    this.readingReaders.delete(reader);
                });
            }
            catch (readErr) {
                const message = readErr instanceof Error ? readErr.message : String(readErr);
                console.log(`[Attempt ${attempt}/${this.maxReadAttempts}] Read error: ${message}`);
                reader.disconnect(() => __awaiter(this, void 0, void 0, function* () {
                    if (attempt < this.maxReadAttempts) {
                        yield (0, delay_1.delay)(this.retryDelayMs);
                        this.connectAndRead(reader, attempt + 1);
                    }
                    else {
                        console.log("Max retry attempts reached — emitting error");
                        this.readingReaders.delete(reader);
                        this.eventEmitter.emit(READ_ERROR_EVENT, message);
                    }
                }));
            }
        }));
    }
    transmitToCard(reader, protocol, command, expectedLength) {
        return new Promise((resolve, reject) => {
            let timeoutHandle;
            if (this.readTimeout > 0) {
                timeoutHandle = setTimeout(() => {
                    reject(new Error("Smart card read timeout"));
                }, this.readTimeout);
            }
            reader.transmit(Buffer.from(command), expectedLength, protocol, (err, data) => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }
                if (err) {
                    reject(err);
                    return;
                }
                resolve(data);
            });
        });
    }
}
exports.default = ThaiIdCardReader;
