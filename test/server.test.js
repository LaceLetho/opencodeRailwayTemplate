import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

// Fake upstream server that openwork-server would be
let upstream
let upstreamPort

before(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ proxied: true, path: req.url }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  upstreamPort = upstream.address().port
})

after(() => new Promise((resolve) => upstream.close(resolve)))

// Helper: start our proxy server pointing to the fake upstream
async function startProxy(password) {
  process.env.SETUP_PASSWORD = password
  process.env.OPENWORK_PORT = String(upstreamPort)
  process.env.PORT = "0"
  const { createProxyServer } = await import("../src/server.js")
  const srv = createProxyServer()
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve))
  return srv
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on("error", reject)
    req.end()
  })
}

function basicAuth(user, pass) {
  return { authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") }
}

describe("proxy server", () => {
  it("GET /healthz returns 200 without auth", async () => {
    const srv = await startProxy("secret")
    const port = srv.address().port
    const res = await get(port, "/healthz")
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    await new Promise((r) => srv.close(r))
  })

  it("GET / without auth returns 401", async () => {
    const srv = await startProxy("secret")
    const port = srv.address().port
    const res = await get(port, "/")
    assert.equal(res.status, 401)
    assert.ok(res.headers["www-authenticate"])
    await new Promise((r) => srv.close(r))
  })

  it("GET / with wrong password returns 401", async () => {
    const srv = await startProxy("secret")
    const port = srv.address().port
    const res = await get(port, "/", basicAuth("openwork", "wrong"))
    assert.equal(res.status, 401)
    await new Promise((r) => srv.close(r))
  })

  it("GET / with correct credentials proxies to upstream", async () => {
    const srv = await startProxy("secret")
    const port = srv.address().port
    const res = await get(port, "/some/path", basicAuth("openwork", "secret"))
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.proxied, true)
    assert.equal(body.path, "/some/path")
    await new Promise((r) => srv.close(r))
  })
})
