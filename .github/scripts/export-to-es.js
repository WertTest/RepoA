// Example skeleton – put all your logic here.
// You can factor this out from the step we wrote earlier.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = async ({ github, context, core, fetch }) => {
  const ES_URL = process.env.ES_URL;
  const ES_API_KEY = process.env.ES_API_KEY;
  const ES_INDEX = process.env.ES_INDEX || 'docs';

  if (!ES_URL || !ES_API_KEY) {
    core.setFailed('Missing ES_URL or ES_API_KEY');
    return;
  }

  const esFetch = (url, opts = {}) =>
    fetch(url, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        authorization: `ApiKey ${ES_API_KEY}`,
        ...(opts.headers || {}),
      },
    });

  const ensureIndex = async (index) => {
    const head = await esFetch(`${ES_URL}/${encodeURIComponent(index)}`, { method: 'HEAD' });
    if (head.status === 200) return;
    if (head.status !== 404) throw new Error(`Index HEAD failed: ${head.status} ${await head.text()}`);
    const create = await esFetch(`${ES_URL}/${index}`, {
      method: 'PUT',
      body: JSON.stringify({
        settings: { number_of_shards: 1, number_of_replicas: 1 },
        // mappings: { properties: { date: { type: 'date' }, author: { type: 'keyword' } } }
      }),
    });
    if (!create.ok) throw new Error(`Create index failed: ${create.status} ${await create.text()}`);
  };

  const listMarkdown = (dir) => {
    const base = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(base)) return [];
    const out = [];
    (function walk(p) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
      }
    })(base);
    return out;
  };

  const deterministicId = (filePath) =>
    crypto.createHash('sha256')
      .update(`${context.repo.owner}/${context.repo.repo}:${path.relative(process.cwd(), filePath)}`)
      .digest('hex');

  // TODO: replace with your exact parsing rules later
  const parseMarkdown = (text) => {
    const fm = /^---\n([\s\S]*?)\n---\n?/m;
    let title = '', author = '', date = '', body = text;
    const m = text.match(fm);
    if (m) {
      const yaml = m[1];
      for (const line of yaml.split('\n')) {
        const [k, ...rest] = line.split(':');
        if (!k) continue;
        const v = rest.join(':').trim().replace(/^['"]|['"]$/g, '');
        if (/^title$/i.test(k))  title  = v;
        if (/^author$/i.test(k)) author = v;
        if (/^date$/i.test(k))   date   = v;
      }
      body = text.slice(m[0].length);
    }
    if (!title) {
      const h1 = text.match(/^#\s+(.+)$/m);
      if (h1) title = h1[1].trim();
    }
    return { title, author, date, body };
  };

  const buildBulkLines = (index, items) => {
    const lines = [];
    for (const it of items) {
      lines.push(JSON.stringify({ update: { _index: index, _id: it.id } }));
      lines.push(JSON.stringify({ doc: it.doc, doc_as_upsert: true }));
    }
    return lines.join('\n') + '\n';
  };

  const bulkUpsert = async (index, docs, { refresh = 'wait_for', chunkSize = 200 } = {}) => {
    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize);
      const body = buildBulkLines(index, chunk);

      let attempt = 0, delay = 1000;
      // _bulk requires NDJSON content-type
      while (true) {
        const res = await esFetch(`${ES_URL}/_bulk?refresh=${encodeURIComponent(refresh)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-ndjson' },
          body
        });
        const text = await res.text();
        if (!res.ok) {
          if ((res.status === 429 || res.status >= 500) && attempt < 3) {
            await new Promise(r => setTimeout(r, delay)); attempt++; delay *= 2; continue;
          }
          throw new Error(`_bulk HTTP ${res.status}: ${text}`);
        }
        const json = JSON.parse(text);
        if (json.errors) {
          const firstErr = json.items.find(x => x.update && x.update.error)?.update.error;
          throw new Error(`_bulk had errors: ${firstErr ? JSON.stringify(firstErr) : '(see logs)'}`);
        }
        core.info(`Bulked ${chunk.length} docs (${i + 1}-${i + chunk.length})`);
        break;
      }
    }
  };

  await ensureIndex(ES_INDEX);

  const files = listMarkdown('test_dir');
  if (files.length === 0) {
    core.info('No Markdown files found in test_dir');
    return;
  }

  const docs = files.map(file => {
    const text = fs.readFileSync(file, 'utf8');
    const data = parseMarkdown(text);
    const id = deterministicId(file);
    return {
      id,
      doc: {
        id,
        path: path.relative(process.cwd(), file),
        repo: context.repo.repo,
        owner: context.repo.owner,
        sha: context.sha,
        updatedAt: new Date().toISOString(),
        ...data
      }
    };
  });

  await bulkUpsert(ES_INDEX, docs, { refresh: 'wait_for', chunkSize: 200 });
  core.info(`Indexed ${docs.length} docs to "${ES_INDEX}"`);
};
