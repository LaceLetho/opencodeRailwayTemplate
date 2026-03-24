const http = require("http")

const proxyWebSocketUpgrade = ({ req, socket, head, targetPort, onError }) => {
  const headers = { ...req.headers }
  delete headers.host
  delete headers.authorization

  const proxyReq = http.request({
    hostname: "127.0.0.1",
    port: targetPort,
    path: req.url,
    method: req.method || "GET",
    headers: {
      ...headers,
      host: `127.0.0.1:${targetPort}`,
    },
  })

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const statusCode = proxyRes.statusCode || 101
    const statusMessage = proxyRes.statusMessage || "Switching Protocols"
    socket.write(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n`)

    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const item of value) {
          socket.write(`${key}: ${item}\r\n`)
        }
        continue
      }
      socket.write(`${key}: ${value}\r\n`)
    }

    socket.write("\r\n")
    if (proxyHead?.length) socket.write(proxyHead)
    if (head?.length) proxySocket.write(head)
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })

  proxyReq.on("response", () => {
    socket.end()
  })

  proxyReq.on("error", (err) => {
    onError?.(err)
    socket.end()
  })

  proxyReq.end()
}

module.exports = {
  proxyWebSocketUpgrade,
}
