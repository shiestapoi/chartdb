import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DIST_DIR = process.env.DIST_DIR || path.join(__dirname, '..', 'dist');
const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'chartdb.db');
const PORT = parseInt(process.env.PORT || '80', 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
        collection TEXT NOT NULL,
        key        TEXT NOT NULL,
        diagram_id TEXT,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (collection, key)
    );
`);
db.exec(
    'CREATE INDEX IF NOT EXISTS idx_entities_collection_diagram ON entities (collection, diagram_id);'
);

const ALLOWED = new Set([
    'diagrams',
    'db_tables',
    'db_relationships',
    'db_dependencies',
    'areas',
    'db_custom_types',
    'notes',
    'config',
    'diagram_filters',
]);

const stmtListAll = db.prepare(
    'SELECT data FROM entities WHERE collection = ?'
);
const stmtListByDiagram = db.prepare(
    'SELECT data FROM entities WHERE collection = ? AND diagram_id = ?'
);
const stmtGet = db.prepare(
    'SELECT data FROM entities WHERE collection = ? AND key = ?'
);
const stmtPut = db.prepare(
    `INSERT OR REPLACE INTO entities (collection, key, diagram_id, data, updated_at)
     VALUES (?, ?, ?, ?, ?)`
);
const stmtDelete = db.prepare(
    'DELETE FROM entities WHERE collection = ? AND key = ?'
);
const stmtDeleteByDiagram = db.prepare(
    'DELETE FROM entities WHERE collection = ? AND diagram_id = ?'
);
const stmtKeysByDiagram = db.prepare(
    'SELECT key, data FROM entities WHERE collection = ? AND diagram_id = ?'
);

const deriveDiagramId = (collection, item) => {
    if (collection === 'config') {
        return null;
    }
    if (collection === 'diagrams') {
        return item.id ?? null;
    }
    return item.diagramId ?? null;
};

const listItems = (collection, diagramId) => {
    const rows = diagramId
        ? stmtListByDiagram.all(collection, diagramId)
        : stmtListAll.all(collection);
    return rows.map((row) => JSON.parse(row.data));
};

const getItem = (collection, key) => {
    const row = stmtGet.get(collection, key);
    return row ? JSON.parse(row.data) : undefined;
};

const putItem = (collection, key, item) => {
    stmtPut.run(
        collection,
        key,
        deriveDiagramId(collection, item),
        JSON.stringify(item),
        Date.now()
    );
    return item;
};

const deleteItem = (collection, key) => {
    stmtDelete.run(collection, key);
};

const deleteByDiagram = (collection, diagramId) => {
    stmtDeleteByDiagram.run(collection, diagramId);
};

const patchItem = (collection, key, attributes) => {
    const existing = getItem(collection, key);
    if (!existing) {
        return undefined;
    }
    const merged = { ...existing, ...attributes };
    if (collection === 'diagrams' && attributes.id && attributes.id !== key) {
        deleteItem(collection, key);
        putItem(collection, String(attributes.id), merged);
    } else {
        putItem(collection, key, merged);
    }
    return merged;
};

const patchByDiagram = (collection, diagramId, attributes) => {
    const rows = stmtKeysByDiagram.all(collection, diagramId);
    for (const row of rows) {
        const merged = { ...JSON.parse(row.data), ...attributes };
        putItem(collection, row.key, merged);
    }
    return rows.length;
};

const transactions = (fn) => {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
};

const applyBulk = (payload) => {
    return transactions(() => {
        for (const op of payload.puts ?? []) {
            if (!ALLOWED.has(op.collection)) {
                continue;
            }
            putItem(op.collection, op.key, op.item);
        }
        for (const op of payload.patches ?? []) {
            if (!ALLOWED.has(op.collection)) {
                continue;
            }
            patchItem(op.collection, op.key, op.attributes ?? {});
        }
        for (const op of payload.deletes ?? []) {
            if (!ALLOWED.has(op.collection)) {
                continue;
            }
            deleteItem(op.collection, op.key);
        }
        for (const op of payload.deletesByDiagram ?? []) {
            if (!ALLOWED.has(op.collection)) {
                continue;
            }
            deleteByDiagram(op.collection, op.diagramId);
        }
        return { ok: true };
    });
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

const readBody = (req) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 50 * 1024 * 1024) {
                reject(new Error('Payload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });

const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload ?? null);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
};

const configJs = () => {
    const env = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
        OPENAI_API_ENDPOINT: process.env.OPENAI_API_ENDPOINT ?? '',
        LLM_MODEL_NAME: process.env.LLM_MODEL_NAME ?? '',
        HIDE_CHARTDB_CLOUD: process.env.HIDE_CHARTDB_CLOUD ?? '',
        DISABLE_ANALYTICS: process.env.DISABLE_ANALYTICS ?? '',
    };
    return `window.env = ${JSON.stringify(env)};\n`;
};

const serveStatic = (req, res, pathname) => {
    const safePath = path
        .normalize(decodeURIComponent(pathname))
        .replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(DIST_DIR, safePath);
    if (!filePath.startsWith(DIST_DIR)) {
        filePath = path.join(DIST_DIR, 'index.html');
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        stat = undefined;
    }

    if (!stat || stat.isDirectory()) {
        const hasExtension = path.extname(pathname) !== '';
        if (hasExtension) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        filePath = path.join(DIST_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const isHashed = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(filePath);
    const headers = {
        'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': isHashed
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
    };

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
};

const handleApi = async (req, res, url) => {
    const segments = url.pathname
        .replace(/^\/api\/?/, '')
        .split('/')
        .filter(Boolean);

    if (segments[0] === 'health') {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (segments[0] === 'bulk') {
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return;
        }
        const payload = await readBody(req);
        sendJson(res, 200, applyBulk(payload));
        return;
    }

    if (segments[0] !== 'collections' || !segments[1]) {
        sendJson(res, 404, { error: 'Unknown endpoint' });
        return;
    }

    const collection = segments[1];
    if (!ALLOWED.has(collection)) {
        sendJson(res, 400, { error: 'Unknown collection' });
        return;
    }

    const key = segments[2] ? decodeURIComponent(segments[2]) : undefined;
    const diagramId = url.searchParams.get('diagramId') ?? undefined;

    switch (req.method) {
        case 'GET': {
            if (key !== undefined) {
                const item = getItem(collection, key);
                if (item === undefined) {
                    sendJson(res, 404, { error: 'Not found' });
                    return;
                }
                sendJson(res, 200, item);
                return;
            }
            sendJson(res, 200, listItems(collection, diagramId));
            return;
        }
        case 'PUT': {
            if (key === undefined) {
                sendJson(res, 400, { error: 'Key required' });
                return;
            }
            const item = await readBody(req);
            sendJson(res, 200, putItem(collection, key, item));
            return;
        }
        case 'PATCH':
        case 'POST': {
            const attributes = await readBody(req);
            if (key !== undefined) {
                const merged = patchItem(collection, key, attributes);
                sendJson(res, merged === undefined ? 404 : 200, merged ?? {
                    error: 'Not found',
                });
                return;
            }
            if (!diagramId) {
                sendJson(res, 400, { error: 'diagramId required' });
                return;
            }
            sendJson(res, 200, {
                updated: patchByDiagram(collection, diagramId, attributes),
            });
            return;
        }
        case 'DELETE': {
            if (key !== undefined) {
                deleteItem(collection, key);
                sendJson(res, 200, { ok: true });
                return;
            }
            if (!diagramId) {
                sendJson(res, 400, { error: 'diagramId required' });
                return;
            }
            deleteByDiagram(collection, diagramId);
            sendJson(res, 200, { ok: true });
            return;
        }
        default:
            sendJson(res, 405, { error: 'Method not allowed' });
    }
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
        if (url.pathname === '/config.js') {
            const body = configJs();
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end(body);
            return;
        }

        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
            await handleApi(req, res, url);
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('Method not allowed');
            return;
        }

        serveStatic(req, res, url.pathname);
    } catch (error) {
        sendJson(res, 500, { error: error.message ?? 'Internal error' });
    }
});

server.listen(PORT, () => {
    console.log(`chartdb server listening on port ${PORT}`);
    console.log(`static: ${DIST_DIR}`);
    console.log(`database: ${DB_PATH}`);
});
