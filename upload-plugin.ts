/**
 * photo-upload Vite 插件（本地开发用）
 * GET    /api/photos      — 返回已上传照片元数据
 * POST   /api/upload      — 接收 base64 图片，存入 public/uploads/
 * DELETE /api/photos/:id  — 删除照片
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { Plugin } from 'vite'
import fs from 'fs'
import path from 'path'

const UPLOADS_DIR = path.resolve('public/uploads')
const META_FILE   = path.join(UPLOADS_DIR, 'metadata.json')

function ensureDir() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

interface PhotoMeta {
  id: string; title: string; src: string; span: string;
  location?: string; year?: number; tint: string;
  filename: string; createdAt: number;
}

function readMeta(): PhotoMeta[] {
  ensureDir()
  if (!fs.existsSync(META_FILE)) return []
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) }
  catch { return [] }
}

function writeMeta(data: PhotoMeta[]) {
  ensureDir()
  fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function jsonResp(res: ServerResponse, data: unknown, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(JSON.stringify(data))
}

export function uploadPlugin(): Plugin {
  ensureDir()
  return {
    name: 'photo-upload',
    configureServer(server) {
      server.middlewares.use('/api/photos', (req, res, next) => {
        if (req.method !== 'GET' || (req.url !== '/' && req.url !== '')) return next()
        jsonResp(res, readMeta())
      })
      server.middlewares.use('/api/photos', (req, res, next) => {
        if (req.method !== 'DELETE') return next()
        const id = (req.url ?? '').replace(/^\//, '').split('?')[0]
        if (!id) return next()
        const meta = readMeta()
        const photo = meta.find(p => p.id === id)
        if (!photo) return jsonResp(res, { error: 'Not found' }, 404)
        const fp = path.join(UPLOADS_DIR, photo.filename)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
        writeMeta(meta.filter(p => p.id !== id))
        jsonResp(res, { success: true })
      })
      server.middlewares.use('/api/upload', async (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
          res.statusCode = 204; res.end(); return
        }
        if (req.method !== 'POST') return next()
        try {
          const body = JSON.parse(await readBody(req))
          const { image, title, location, year, span, tint } = body
          if (!image) return jsonResp(res, { error: 'No image' }, 400)
          const match = image.match(/^data:image\/(\w+);base64,(.+)$/)
          if (!match) return jsonResp(res, { error: 'Invalid format' }, 400)
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
          const id  = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          fs.writeFileSync(path.join(UPLOADS_DIR, `${id}.${ext}`), Buffer.from(match[2], 'base64'))
          const photo: PhotoMeta = {
            id, title: title || '未命名', src: `/uploads/${id}.${ext}`,
            span: span || 'normal', location: location || '',
            year: year ? Number(year) : new Date().getFullYear(),
            tint: tint || 'rgba(180,180,180,0.22)',
            filename: `${id}.${ext}`, createdAt: Date.now(),
          }
          const meta = readMeta(); meta.unshift(photo); writeMeta(meta)
          jsonResp(res, photo)
        } catch (err) { jsonResp(res, { error: String(err) }, 500) }
      })
    },
  }
}
