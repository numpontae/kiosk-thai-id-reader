import WebSocket from "ws"
import { randomUUID } from "crypto"

const HUB_PORT = Number(process.env.HUB_PORT ?? 8080)
const REQUEST_TIMEOUT_MS = Number(process.env.READ_REQUEST_TIMEOUT_MS ?? 60000)

type Role = "ipad" | "reader"

interface ClientInfo {
  ws: WebSocket
  id: string
  role: Role
  name: string
  busy: boolean
  currentRequestId?: string
}

interface PendingRequest {
  clientId: string
  readerId?: string
  timeout: NodeJS.Timeout
}

const clients = new Map<string, ClientInfo>()
const pendingRequests = new Map<string, PendingRequest>()

function send(ws: WebSocket, payload: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function readersOnline() {
  return [...clients.values()].filter((c) => c.role === "reader").length
}

function idleReaders() {
  return [...clients.values()].filter((c) => c.role === "reader" && !c.busy)
}

function broadcastReaderStatus() {
  const count = readersOnline()
  for (const client of clients.values()) {
    if (client.role === "ipad") {
      send(client.ws, { type: "reader_status", readersOnline: count })
    }
  }
}

function releaseReader(readerId: string) {
  const reader = clients.get(readerId)
  if (!reader) return
  reader.busy = false
  reader.currentRequestId = undefined
}

function clearPendingRequest(requestId: string) {
  const pending = pendingRequests.get(requestId)
  if (!pending) return
  clearTimeout(pending.timeout)
  if (pending.readerId) {
    releaseReader(pending.readerId)
  }
  pendingRequests.delete(requestId)
}

function assignReadRequest(ipadClient: ClientInfo) {
  const reader = idleReaders()[0]
  if (!reader) {
    send(ipadClient.ws, {
      type: "no_reader",
      message: "ไม่พบเครื่องอ่านบัตรที่พร้อมใช้งาน",
    })
    return
  }

  const requestId = randomUUID()
  reader.busy = true
  reader.currentRequestId = requestId

  const timeout = setTimeout(() => {
    const pending = pendingRequests.get(requestId)
    if (!pending) return

    send(ipadClient.ws, {
      type: "read_timeout",
      requestId,
      message: "หมดเวลารอการอ่านบัตร กรุณาลองใหม่อีกครั้ง",
    })

    send(reader.ws, {
      type: "read_cancel",
      requestId,
    })

    clearPendingRequest(requestId)
  }, REQUEST_TIMEOUT_MS)

  pendingRequests.set(requestId, {
    clientId: ipadClient.id,
    readerId: reader.id,
    timeout,
  })

  send(ipadClient.ws, {
    type: "read_requested",
    requestId,
    readerName: reader.name,
  })

  send(reader.ws, {
    type: "read_request",
    requestId,
    clientId: ipadClient.id,
  })

  console.log(
    `Assigned request ${requestId} → reader "${reader.name}" (iPad ${ipadClient.name})`
  )
}

const wss = new WebSocket.Server({ port: HUB_PORT })

wss.on("listening", () => {
  console.log(`Card Reader Hub listening on ws://0.0.0.0:${HUB_PORT}`)
})

wss.on("connection", (ws) => {
  const clientId = randomUUID()
  let registered = false

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw))

      if (msg.type === "register") {
        const role = msg.role as Role
        if (role !== "ipad" && role !== "reader") {
          send(ws, { type: "error", message: "Invalid role" })
          return
        }

        const name =
          String(msg.name || "").trim() ||
          (role === "reader" ? `Reader-${clientId.slice(0, 6)}` : `iPad-${clientId.slice(0, 6)}`)

        clients.set(clientId, {
          ws,
          id: clientId,
          role,
          name,
          busy: false,
        })
        registered = true

        send(ws, {
          type: "registered",
          clientId,
          role,
          name,
          readersOnline: readersOnline(),
        })

        console.log(`Registered ${role} "${name}" (${clientId})`)
        broadcastReaderStatus()
        return
      }

      if (!registered) {
        send(ws, { type: "error", message: "Not registered" })
        return
      }

      const client = clients.get(clientId)
      if (!client) return

      if (msg.type === "read_request" && client.role === "ipad") {
        assignReadRequest(client)
        return
      }

      if (msg.type === "card_read" && client.role === "reader") {
        const requestId = String(msg.requestId || "")
        const pending = pendingRequests.get(requestId)
        if (!pending) return

        const ipad = clients.get(pending.clientId)
        if (ipad) {
          send(ipad.ws, {
            type: "card_read",
            requestId,
            data: msg.data,
            readerName: client.name,
          })
        }

        clearPendingRequest(requestId)
        return
      }

      if (msg.type === "card_error" && client.role === "reader") {
        const requestId = String(msg.requestId || "")
        const pending = pendingRequests.get(requestId)
        if (!pending) return

        const ipad = clients.get(pending.clientId)
        if (ipad) {
          send(ipad.ws, {
            type: "card_error",
            requestId,
            error: msg.error || "Card read failed",
            readerName: client.name,
          })
        }

        clearPendingRequest(requestId)
        return
      }

      if (msg.type === "reader_ready" && client.role === "reader") {
        client.busy = false
        client.currentRequestId = undefined
        return
      }
    } catch (err) {
      console.error("Hub message error:", err)
    }
  })

  ws.on("close", () => {
    const client = clients.get(clientId)
    if (!client) return

    console.log(`Disconnected ${client.role} "${client.name}" (${clientId})`)

    if (client.role === "reader" && client.currentRequestId) {
      const pending = pendingRequests.get(client.currentRequestId)
      if (pending) {
        const ipad = clients.get(pending.clientId)
        if (ipad) {
          send(ipad.ws, {
            type: "card_error",
            requestId: client.currentRequestId,
            error: "เครื่องอ่านบัตรขาดการเชื่อมต่อ",
          })
        }
        clearPendingRequest(client.currentRequestId)
      }
    }

    clients.delete(clientId)
    broadcastReaderStatus()
  })
})
