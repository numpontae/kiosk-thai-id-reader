import os from "os"
import WebSocket from "ws"
import { ThaiIdCardReader } from "./index"

const HUB_URL = process.env.HUB_URL ?? "ws://localhost:8080"
const READER_NAME = process.env.READER_NAME ?? os.hostname()

type PendingRequest = {
  requestId: string
  clientId: string
}

let ws: WebSocket | null = null
let pendingRequest: PendingRequest | null = null
let retryDelayMs = 2000

function send(payload: object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function clearPendingRequest() {
  pendingRequest = null
  reader.setReadGate(false)
  send({ type: "reader_ready" })
}

function connectHub() {
  console.log(`Connecting to hub: ${HUB_URL}`)
  ws = new WebSocket(HUB_URL)

  ws.on("open", () => {
    console.log("Connected to hub")
    retryDelayMs = 2000
    send({
      type: "register",
      role: "reader",
      name: READER_NAME,
    })
  })

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(String(raw))

      if (msg.type === "registered") {
        console.log(`Registered as reader "${msg.name}" (${msg.clientId})`)
        return
      }

      if (msg.type === "read_request") {
        pendingRequest = {
          requestId: String(msg.requestId),
          clientId: String(msg.clientId),
        }

        console.log(`Read request ${pendingRequest.requestId} from iPad ${pendingRequest.clientId}`)
        reader.setReadGate(true)

        const started = await reader.requestRead()
        if (!started) {
          console.log("Waiting for card insert...")
        }
        return
      }

      if (msg.type === "read_cancel") {
        console.log(`Read request cancelled: ${msg.requestId}`)
        if (pendingRequest?.requestId === msg.requestId) {
          clearPendingRequest()
        }
      }
    } catch (err) {
      console.error("Hub message error:", err)
    }
  })

  ws.on("close", () => {
    console.log(`Hub disconnected — retry in ${retryDelayMs / 1000}s`)
    setTimeout(connectHub, retryDelayMs)
    retryDelayMs = Math.min(retryDelayMs * 2, 30000)
  })

  ws.on("error", (err) => {
    console.error("Hub connection error:", err.message || "Connection refused — is hub running? Run: npm run hub")
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close()
    }
  })
}

const reader = new ThaiIdCardReader({
  insertCardDelay: 1000,
  readTimeout: 5000,
  maxReadAttempts: 3,
  retryDelayMs: 2000,
  postRemovalSettleMs: 3000,
})

console.log("Reader config", {
  insertCardDelay: 1000,
  readTimeout: 5000,
  maxReadAttempts: 3,
  retryDelayMs: 2000,
  postRemovalSettleMs: 3000,
  hubUrl: HUB_URL,
  readerName: READER_NAME,
})

reader.setReadGate(false)
reader.init()

reader.onReadComplete((data) => {
  if (!pendingRequest) {
    console.log("Card read complete (no pending request — ignored)")
    return
  }

  console.log("Card read complete — sending to hub")
  send({
    type: "card_read",
    requestId: pendingRequest.requestId,
    data,
  })
  clearPendingRequest()
})

reader.onReadError((error) => {
  if (!pendingRequest) {
    console.error("Card read error (no pending request):", error)
    return
  }

  console.error("Card read error — sending to hub:", error)
  send({
    type: "card_error",
    requestId: pendingRequest.requestId,
    error,
  })
  clearPendingRequest()
})

connectHub()
