// Transcribe WhatsApp audio URLs with Groq Whisper; key read from the memory file (never printed / never argv).
import { readFileSync } from 'node:fs'
const key = readFileSync('C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/groq-key.txt', 'utf8').trim().split(/\s+/).find(t => t.startsWith('gsk_')) || readFileSync('C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/groq-key.txt', 'utf8').trim()
for (const url of process.argv.slice(2)) {
  const r = await fetch(url); if (!r.ok) { console.log('DOWNLOAD FAIL', r.status, url.slice(-12)); continue }
  const buf = Buffer.from(await r.arrayBuffer())
  const fd = new FormData(); fd.append('file', new Blob([buf], { type: 'audio/ogg' }), 'a.ogg'); fd.append('model', 'whisper-large-v3-turbo'); fd.append('language', 'pt')
  const t = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd })
  const j = await t.json().catch(() => ({})); console.log('---', url.slice(-12), buf.length, 'bytes'); console.log(j.text ?? JSON.stringify(j).slice(0, 300))
}
