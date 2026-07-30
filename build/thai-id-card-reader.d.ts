import type { SmartCardReturnData } from "./smart-card-return-data";
export type ThaiIdCardReaderOptions = {
    insertCardDelay?: number;
    readTimeout?: number;
    maxReadAttempts?: number;
    retryDelayMs?: number;
    postRemovalSettleMs?: number;
};
export default class ThaiIdCardReader {
    private eventEmitter;
    private readTimeout;
    private insertCardDelay;
    private maxReadAttempts;
    private retryDelayMs;
    private postRemovalSettleMs;
    private readingReaders;
    private lastRemovedAt;
    private pcscInstance;
    private pcscReinitTimer;
    private pcscGeneration;
    constructor(options?: ThaiIdCardReaderOptions);
    setReadTimeout(timeout: number): void;
    setInsertCardDelay(timeout: number): void;
    onReadComplete(callBack: (data: Partial<SmartCardReturnData>) => void): void;
    onReadError(callBack: (error: string) => void): void;
    init(): void;
    private startPCSC;
    private schedulePCSCReinit;
    private connectAndRead;
    private transmitToCard;
}
