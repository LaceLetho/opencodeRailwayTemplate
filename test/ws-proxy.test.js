const assert = require("assert").strict
const http = require("http")
const net = require("net")
const crypto = require("crypto")

const { proxyWebSocketUpgrade } = require("../ws-proxy")

const createAccept = (key) =>
  crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

const close = (server) =>
  new Promise((resolve) => server.close(resolve))

const run = async () => {
  const upstream = http.createServer()
  upstream.on("upgrade", (req, socket) => {
    const accept = createAccept(req.headers["sec-websocket-key"])
    socket.write("HTTP/1.1 101 Switching Protocols\r\n")
    socket.write("Upgrade: websocket\r\n")
    socket.write("Connection: Upgrade\r\n")
    socket.write(`Sec-WebSocket-Accept: ${accept}\r\n`)
    socket.write("\r\n")
    socket.end()
  })
  await listen(upstream)
  const upstreamPort = upstream.address().port

  const proxy = http.createServer()
  proxy.on("upgrade", (req, socket, head) => {
    proxyWebSocketUpgrade({ req, socket, head, targetPort: upstreamPort })
  })
  await listen(proxy)
  const proxyPort = proxy.address().port

  const key = crypto.randomBytes(16).toString("base64")
  const handshake = [
    "GET /pty/test/connect HTTP/1.1",
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n")

  const response = await new Promise((resolve, reject) => {
    const client = net.connect(proxyPort, "127.0.0.1")
    let data = ""

    client.on("connect", () => {
      client.write(handshake)
    })

    client.on("data", (chunk) => {
      data += chunk.toString("utf8")
      if (!data.includes("\r\n\r\n")) return
      client.end()
      resolve(data)
    })

    client.on("error", reject)
  })

  assert.match(response, /^HTTP\/1\.1 101 /)
  assert.match(response, /Upgrade: websocket/i)
  assert.match(response, /Connection: Upgrade/i)
  assert.match(response, new RegExp(`Sec-WebSocket-Accept: ${escapeRegex(createAccept(key))}`, "i"))

  await close(proxy)
  await close(upstream)
  console.log("ws proxy handshake ok")
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
