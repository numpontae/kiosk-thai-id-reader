import EventEmitter from "events"
import PCSC from "pcsclite"

import type { SmartCardReturnData } from "./smart-card-return-data"
import { normalizeCardData } from "./reader/normalize-card-data"
import {
  createCommandTransmitter,
  readCardData,
} from "./reader/read-card-data"
import { delay } from "./utils/delay"

const READ_COMPLETE_EVENT = "READ_COMPLETE"
const READ_ERROR_EVENT = "READ_ERROR"

export type ThaiIdCardReaderOptions = {
  insertCardDelay?: number
  readTimeout?: number
  maxReadAttempts?: number
  retryDelayMs?: number
  postRemovalSettleMs?: number
}

export default class ThaiIdCardReader {
  private eventEmitter: EventEmitter
  private readTimeout = 0
  private insertCardDelay = 1000
  private maxReadAttempts = 3
  private retryDelayMs = 2000
  private postRemovalSettleMs = 3000
  private readingReaders = new Set<any>()
  private lastRemovedAt = new Map<any, number>()
  private pcscInstance: any = null
  private pcscReinitTimer: NodeJS.Timeout | undefined
  private pcscGeneration = 0
  private readGateEnabled = false
  private activeReaders = new Map<string, any>()
  private readerPresent = new Map<any, boolean>()

  constructor(options: ThaiIdCardReaderOptions = {}) {
    this.eventEmitter = new EventEmitter()
    this.insertCardDelay = options.insertCardDelay ?? this.insertCardDelay
    this.readTimeout = options.readTimeout ?? this.readTimeout
    this.maxReadAttempts = options.maxReadAttempts ?? this.maxReadAttempts
    this.retryDelayMs = options.retryDelayMs ?? this.retryDelayMs
    this.postRemovalSettleMs = options.postRemovalSettleMs ?? this.postRemovalSettleMs
  }

  setReadTimeout(timeout: number) {
    this.readTimeout = timeout
  }

  setInsertCardDelay(timeout: number) {
    this.insertCardDelay = timeout
  }

  setReadGate(enabled: boolean) {
    this.readGateEnabled = enabled
    console.log(`Read gate: ${enabled ? "OPEN" : "CLOSED"}`)
  }

  hasActiveReader() {
    return this.activeReaders.size > 0
  }

  async requestRead(): Promise<boolean> {
    if (!this.readGateEnabled) {
      return false
    }

    for (const reader of this.activeReaders.values()) {
      if (this.readingReaders.has(reader)) {
        continue
      }

      if (!this.readerPresent.get(reader)) {
        continue
      }

      const removedAt = this.lastRemovedAt.get(reader) ?? 0
      const timeSinceRemoval = Date.now() - removedAt
      const settleWait = Math.max(0, this.postRemovalSettleMs - timeSinceRemoval)
      const totalWait = this.insertCardDelay + settleWait

      console.log(`requestRead: starting read on "${reader.name}" (wait ${totalWait}ms)`)
      await delay(totalWait)
      this.connectAndRead(reader)
      return true
    }

    console.log("requestRead: no reader with card present")
    return false
  }

  onReadComplete(callBack: (data: Partial<SmartCardReturnData>) => void) {
    this.eventEmitter.on(
      READ_COMPLETE_EVENT,
      (data: Partial<SmartCardReturnData>) => {
        callBack(normalizeCardData(data))
      }
    )
  }

  onReadError(callBack: (error: string) => void) {
    this.eventEmitter.on(READ_ERROR_EVENT, (error: string) => {
      callBack(error)
    })
  }

  init() {
    this.startPCSC()
  }

  private startPCSC() {
    if (this.pcscInstance) {
      try {
        this.pcscInstance.close()
      } catch {
        // ignore cleanup errors from stale instance
      }
      this.pcscInstance = null
    }

    this.pcscGeneration++
    const generation = this.pcscGeneration

    console.log("ThaiSmartCardConnector init")

    const pcsc = PCSC()
    this.pcscInstance = pcsc

    pcsc.on("reader", (reader) => {
      if (this.pcscGeneration !== generation) return

      // Cancel pending re-init — this pcsc context can still detect readers
      if (this.pcscReinitTimer) {
        clearTimeout(this.pcscReinitTimer)
        this.pcscReinitTimer = undefined
        console.log("Reader detected — PCSC re-init cancelled")
      }

      console.log("New reader detected", reader.name)
      this.activeReaders.set(reader.name, reader)

      reader.on("error", (err) => {
        console.log("Error(", reader.name, "):", err.message)
      })

      reader.on("status", async (status) => {
        if (this.pcscGeneration !== generation) return

        const isPresent = !!(status.state & reader.SCARD_STATE_PRESENT)
        this.readerPresent.set(reader, isPresent)

        const changes = reader.state ^ status.state
        if (!changes) {
          return
        }

        if (
          changes & reader.SCARD_STATE_EMPTY &&
          status.state & reader.SCARD_STATE_EMPTY
        ) {
          console.log("card removed")
          this.lastRemovedAt.set(reader, Date.now())
          this.readingReaders.delete(reader)
          reader.disconnect(reader.SCARD_LEAVE_CARD, (err) => {
            if (err) console.log("disconnect on removal:", err.message)
          })
          return
        }

        if (
          changes & reader.SCARD_STATE_PRESENT &&
          status.state & reader.SCARD_STATE_PRESENT
        ) {
          if (!this.readGateEnabled) {
            console.log("card inserted (read gate closed — waiting for request)")
            return
          }

          if (this.readingReaders.has(reader)) {
            return
          }

          const removedAt = this.lastRemovedAt.get(reader) ?? 0
          const timeSinceRemoval = Date.now() - removedAt
          const settleWait = Math.max(0, this.postRemovalSettleMs - timeSinceRemoval)
          const totalWait = this.insertCardDelay + settleWait

          if (settleWait > 0) {
            console.log(`card inserted (recent removal detected, settling ${settleWait}ms + ${this.insertCardDelay}ms = ${totalWait}ms)`)
          } else {
            console.log(`card inserted (waiting ${this.insertCardDelay}ms)`)
          }

          await delay(totalWait)
          this.connectAndRead(reader)
        }
      })

      reader.on("end", () => {
        if (this.pcscGeneration !== generation) return

        console.log("Reader", reader.name, "removed — scheduling PCSC re-init")
        this.activeReaders.delete(reader.name)
        this.readerPresent.delete(reader)
        this.readingReaders.delete(reader)
        this.lastRemovedAt.delete(reader)
        this.schedulePCSCReinit()
      })
    })

    pcsc.on("error", (err) => {
      if (this.pcscGeneration !== generation) return

      console.log("PCSC error", err.message)
      this.eventEmitter.emit(READ_ERROR_EVENT, err.message)
      this.schedulePCSCReinit()
    })
  }

  private schedulePCSCReinit(delayMs = 5000) {
    if (this.pcscReinitTimer) {
      clearTimeout(this.pcscReinitTimer)
    }
    console.log(`Will re-init PCSC in ${delayMs}ms to detect reader re-plug...`)
    this.pcscReinitTimer = setTimeout(() => {
      this.pcscReinitTimer = undefined
      console.log("Re-initializing PCSC context...")
      this.startPCSC()
    }, delayMs)
  }

  private connectAndRead(reader: any, attempt = 1) {
    if (attempt === 1) {
      this.readingReaders.add(reader)
    }

    reader.connect(
      { share_mode: reader.SCARD_SHARE_SHARED },
      async (connectErr: Error | null, protocol: number) => {
        if (connectErr) {
          console.log(`[Attempt ${attempt}/${this.maxReadAttempts}] Connect error: ${connectErr.message}`)
          if (attempt < this.maxReadAttempts) {
            await delay(this.retryDelayMs)
            this.connectAndRead(reader, attempt + 1)
          } else {
            console.log("Max retry attempts reached — emitting error")
            this.readingReaders.delete(reader)
            this.eventEmitter.emit(READ_ERROR_EVENT, connectErr.message)
          }
          return
        }

        try {
          const sendRawCommand = createCommandTransmitter((command, expected) =>
            this.transmitToCard(reader, protocol, command, expected)
          )
          const data = await readCardData(sendRawCommand)
          this.eventEmitter.emit(READ_COMPLETE_EVENT, data)
          reader.disconnect(() => {
            // console.log("Card read complete — reader disconnected")
            this.readingReaders.delete(reader)
          })
        } catch (readErr) {
          const message = readErr instanceof Error ? readErr.message : String(readErr)
          console.log(`[Attempt ${attempt}/${this.maxReadAttempts}] Read error: ${message}`)
          reader.disconnect(async () => {
            if (attempt < this.maxReadAttempts) {
              await delay(this.retryDelayMs)
              this.connectAndRead(reader, attempt + 1)
            } else {
              console.log("Max retry attempts reached — emitting error")
              this.readingReaders.delete(reader)
              this.eventEmitter.emit(READ_ERROR_EVENT, message)
            }
          })
        }
      }
    )
  }

  private transmitToCard(
    reader: any,
    protocol: number,
    command: number[],
    expectedLength: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | undefined

      if (this.readTimeout > 0) {
        timeoutHandle = setTimeout(() => {
          reject(new Error("Smart card read timeout"))
        }, this.readTimeout)
      }

      reader.transmit(
        Buffer.from(command),
        expectedLength,
        protocol,
        (err: Error | null, data: Buffer) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle)
          }

          if (err) {
            reject(err)
            return
          }

          resolve(data)
        }
      )
    })
  }
}
