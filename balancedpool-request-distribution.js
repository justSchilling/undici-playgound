'use strict'

const http = require('node:http')
const { setTimeout: sleep } = require('node:timers/promises')
const { BalancedPool } = require('undici')

const BACKENDS = [
  { name: 'A', port: 3101 },
  { name: 'B', port: 3102 },
]

function createBackend (backend) {
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      backend: backend.name,
      port: backend.port,
      path: req.url
    }))
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    backend,
    server,
    async start () {
      if (server.listening) return
      await new Promise((resolve, reject) => {
        server.listen(backend.port, '127.0.0.1', (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      console.log(`started backend ${backend.name} on :${backend.port}`)
    },
    async stop () {
      if (!server.listening) return
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve) => server.close(resolve))
      console.log(`stopped backend ${backend.name} on :${backend.port}`)
    }
  }
}

function extractPortFromError (err) {
  const seen = new Set()
  let current = err

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)

    if (typeof current.port === 'number') {
      return current.port
    }

    if (typeof current.message === 'string') {
      const match = current.message.match(/:(\d+)(?:\)|\s|$)/)
      if (match) return Number(match[1])
    }

    current = current.cause
  }

  return undefined
}

function phaseSummary (phase, records) {
  const totals = {}
  for (const key of records) {
    totals[key] = (totals[key] || 0) + 1
  }
  console.log(`\n${phase} summary:`)
  for (const [key, count] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}`)
  }
}

async function runPhase (pool, phaseName, count, delayMs) {
  const records = []
  console.log(`\n=== ${phaseName} (${count} requests) ===`)

  for (let i = 0; i < count; i++) {
    try {
      const { statusCode, body } = await pool.request({
        method: 'GET',
        path: '/ping',
        headersTimeout: 500,
        bodyTimeout: 5001
      })

      const payload = JSON.parse(await body.text())
      const label = `OK:${payload.backend}:${payload.port}:${statusCode}`
      records.push(label)
      console.log(`${String(i + 1).padStart(2, '0')}. ${label}`)
    } catch (err) {
      const port = extractPortFromError(err)
      const backend = BACKENDS.find(b => b.port === port)?.name || 'unknown'
      const label = `ERR:${backend}:${port ?? 'n/a'}:${err.code || err.name}`
      records.push(label)
      console.log(`${String(i + 1).padStart(2, '0')}. ${label}`)
    }

    if (delayMs > 0) {
      await sleep(delayMs)
    }
  }

  phaseSummary(phaseName, records)
}

async function main () {
  const backends = BACKENDS.map(createBackend)
  const pool = new BalancedPool(
    BACKENDS.map((b) => `http://127.0.0.1:${b.port}`),
    {
      connections:1,
      pipelining: 0,
      connectTimeout: 200,
      keepAliveTimeout: 1000,
    }
  )

  pool.on('connectionError', (origin, _targets, error) => {
    const port = extractPortFromError(error) || origin.port
    const backend = BACKENDS.find(b => String(b.port) === String(port))?.name || 'unknown'
    console.log(`event: connectionError from ${backend}:${port} (${error.code || error.name})`)
  })

  try {
    for (const backend of backends) {
      await backend.start()
    }
    await sleep(100)
    await runPhase(pool, 'phase1_all_up', 12, 25)

    for (const backend of backends) {
      await backend.stop()
    }
    await sleep(100)
    await runPhase(pool, 'phase2_all_down', 24, 25)

    await backends[0].start()
    await sleep(100)
    await runPhase(pool, 'phase3_A_up', 24, 25)

    for (const backend of backends) {
      await backend.start()
    }

    await sleep(100)
    await runPhase(pool, 'phase4_all_up_again', 12, 25)
  } finally {
    await Promise.allSettled(backends.map(backend => backend.stop()))
    await pool.destroy()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
