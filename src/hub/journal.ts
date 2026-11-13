// Hub mode (#300, HUB-BUILD-PLAN H3): PGlite cannot fsync, so every op is also
// appended to dataDir/outbox.log (one JSON line per op) and fsynced before the
// till is told the write worked (PGlite spike: "a durable op journal").
// outbox.ack holds the highest seq the cloud has acknowledged (H4 writes it).
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurably } from './import'
import type { HubOp } from './outbox'

const LOG = 'outbox.log'
const ACK = 'outbox.ack'

/** Appends one op and fsyncs it; returns only once it is on disk. */
export function appendOp(dataDir: string, op: HubOp): void {
  const fd = openSync(join(dataDir, LOG), 'a')
  try {
    appendFileSync(fd, `${JSON.stringify(op)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Every op in the journal. A torn last line (power cut mid-append - its HTTP reply was never sent) is skipped. */
export function readJournal(dataDir: string): HubOp[] {
  const path = join(dataDir, LOG)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  const ops: HubOp[] = []
  for (const [i, line] of lines.entries()) {
    if (!line) continue
    try {
      ops.push(JSON.parse(line) as HubOp)
    } catch (error) {
      if (i !== lines.length - 1) throw error // only a last line with no newline can be torn
    }
  }
  return ops
}

export function writeAck(dataDir: string, seq: number): void {
  writeDurably(join(dataDir, ACK), String(seq))
}

/** The highest acknowledged seq, 0 when none. */
export function readAck(dataDir: string): number {
  const path = join(dataDir, ACK)
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0
}

/**
 * At startup only: once the cloud has acknowledged every op in the journal, cuts it down to the
 * last op - kept so a store rebuilt from the journal (H5) still knows the next seq. Returns whether it did.
 */
export function compactJournal(dataDir: string): boolean {
  const ops = readJournal(dataDir)
  if (ops.length < 2 || ops[ops.length - 1].seq > readAck(dataDir)) return false
  writeDurably(join(dataDir, LOG), `${JSON.stringify(ops[ops.length - 1])}\n`)
  return true
}

/** At startup only (H5): cuts a torn last line (power cut mid-append) so the next append starts a line of its own. */
export function repairJournal(dataDir: string): void {
  const path = join(dataDir, LOG)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (text !== '' && !text.endsWith('\n')) writeDurably(path, text.slice(0, text.lastIndexOf('\n') + 1))
}
