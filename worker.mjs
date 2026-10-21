const SCHEMA_VERSION = 1;
const SNAPSHOT_FRESH_MS = 60 * 60 * 1000; // 1h
const SNAPSHOT_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const SNAPSHOT_RETENTION_SECONDS = 60 * 24 * 60 * 60; // 60d
const EDGE_TTL_SECONDS = 60 * 60; // 1h
const UPSTREAM_TIMEOUT_MS = 15_000; // 15s
const MAX_README_BYTES = 256 * 1024; // 256KB
const MAX_TREE_RESPONSE_BYTES = 1024 * 1024; // 1MB
const MAX_CDN_LISTING_BYTES = 1024 * 1024; // 1MB
const MAX_TREE_ENTRIES = 5_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return serveAsset(request, env);
    }

    const route = parseRepositoryRootRoute(url.pathname);
    if (!route) return serveAsset(request, env);

    const format = url.searchParams.get('format') === 'markdown' || acceptsMarkdown(request.headers.get('Accept')) ? 'markdown' : 'html';
    const cache = caches.default;
    const cacheKey = new Request(
      `${url.origin}/__litegh_cache/v${SCHEMA_VERSION}/${encodeURIComponent(route.owner.toLowerCase())}/${encodeURIComponent(route.repo.toLowerCase())}/${format}`,
      { method: 'GET' },
    );

    try {
      const edgeHit = await cache.match(cacheKey);
      if (edgeHit) {
        const headers = new Headers(edgeHit.headers);
        headers.set('X-LiteGH-SSR-Cache', 'HIT');
        return new Response(request.method === 'HEAD' ? null : edgeHit.body, {
          status: edgeHit.status,
          statusText: edgeHit.statusText,
          headers,
        });
      }
    } catch (error) {
      console.warn('LiteGH edge cache lookup failed:', error);
    }

    const snapshotKey = `repo:v${SCHEMA_VERSION}:${route.owner.toLowerCase()}/${route.repo.toLowerCase()}`;
    let snapshot = null;
    try {
      snapshot = env.REPO_SNAPSHOTS ? await env.REPO_SNAPSHOTS.get(snapshotKey, 'json') : null;
    } catch (error) {
      console.warn('LiteGH KV read failed:', error);
    }

    let cacheStatus = 'MISS';
    if (!isValidSnapshot(snapshot, route)) {
      snapshot = null;
    } else {
      const snapshotAge = Date.now() - Date.parse(snapshot.fetchedAt);
      if (Number.isFinite(snapshotAge) && snapshotAge <= SNAPSHOT_FRESH_MS) {
        cacheStatus = 'KV-HIT';
      } else if (Number.isFinite(snapshotAge) && snapshotAge <= SNAPSHOT_MAX_STALE_MS) {
        cacheStatus = 'STALE';
      } else {
        snapshot = null;
      }
    }

    if (snapshot && cacheStatus === 'STALE') {
      ctx.waitUntil(refreshSnapshot(route, env).catch((error) => console.warn('LiteGH stale refresh failed:', error)));
    }

    if (!snapshot) {
      try {
        snapshot = await buildSnapshot(route.owner, route.repo, env);
        if (snapshot?.metadata?.private) {
          return serveShellWithoutSSR(request, env);
        }
        if (!snapshot || !snapshot.tree?.length) {
          return serveShellWithoutSSR(request, env);
        }
        if (env.REPO_SNAPSHOTS) {
          ctx.waitUntil(env.REPO_SNAPSHOTS.put(snapshotKey, JSON.stringify(snapshot), {
            expirationTtl: SNAPSHOT_RETENTION_SECONDS,
          }).catch((error) => console.warn('LiteGH KV write failed:', error)));
        }
        cacheStatus = 'BUILT';
      } catch (error) {
        console.warn(`LiteGH SSR could not build ${route.owner}/${route.repo}:`, error);
        return serveShellWithoutSSR(request, env);
      }
    }

    const response = format === 'markdown'
      ? renderMarkdownResponse(snapshot, route, cacheStatus)
      : await renderHtmlResponse(snapshot, route, request, env, cacheStatus);

    try {
      if (response.ok && response.headers.get('Cache-Control')?.includes('public')) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()).catch((error) => console.warn('LiteGH edge cache write failed:', error)));
      }
    } catch (error) {
      console.warn('LiteGH edge cache write failed:', error);
    }
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
  },
};

async function serveAsset(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Deep GitHub-style routes are client-side LiteGH routes; return the app shell.
  if (isLiteGHClientRoute(pathname)) return serveShellWithoutSSR(request, env);

  // Serve the assets bundled with this Worker, but preserve unrelated PHP/API
  // endpoints and other origin routes by passing them through to the existing origin.
  if (env.ASSETS && isBundledStaticAsset(pathname)) return env.ASSETS.fetch(request);
  return fetch(request);
}

function isLiteGHClientRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  return parts.length >= 4 && /^[A-Za-z0-9_.-]{1,100}$/.test(parts[0]) &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) && ['blob', 'tree'].includes(parts[2]) && Boolean(parts[3]);
}

function isBundledStaticAsset(pathname) {
  if (['/', '/index.html', '/manifest.webmanifest', '/sw.js'].includes(pathname)) return true;
  return pathname.startsWith('/icons/');
}

async function serveShellWithoutSSR(request, env) {
  if (!env.ASSETS) return new Response('Configure the ASSETS binding in wrangler.toml.', { status: 500 });
  const baseUrl = new URL('/', request.url);
  let response = await env.ASSETS.fetch(new Request(baseUrl, { method: 'GET', headers: request.headers }));
  if (!response.ok) {
    response = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), { method: 'GET' }));
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-LiteGH-SSR-Cache', 'BYPASS');
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    headers,
  });
}

function parseRepositoryRootRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  let owner, repo;
  try {
    owner = decodeURIComponent(parts[0]);
    repo = decodeURIComponent(parts[1]);
  } catch (_) {
    return null;
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  if (/^(?:api|auth|oauth|callback|health|healthz|icons|assets|fonts|images|css|js|\.well-known)$/i.test(owner) || /\.(?:php|phtml|asp|aspx|cgi|html?|css|js|mjs|cjs|json|webmanifest|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map)$/i.test(repo)) return null;
  return { owner, repo };
}

function acceptsMarkdown(accept) {
  return /(?:^|,)\s*text\/markdown\b/i.test(String(accept || ''));
}

function isValidSnapshot(snapshot, route) {
  return Boolean(snapshot && snapshot.schemaVersion === SCHEMA_VERSION &&
    snapshot.owner?.toLowerCase() === route.owner.toLowerCase() &&
    snapshot.repo?.toLowerCase() === route.repo.toLowerCase() &&
    snapshot.branch && Array.isArray(snapshot.tree) && snapshot.metadata && snapshot.fetchedAt);
}

async function refreshSnapshot(route, env) {
  if (!env.REPO_SNAPSHOTS) return;
  const fresh = await buildSnapshot(route.owner, route.repo, env);
  if (!fresh || fresh.metadata?.private || !fresh.tree?.length) return;
  await env.REPO_SNAPSHOTS.put(`repo:v${SCHEMA_VERSION}:${route.owner.toLowerCase()}/${route.repo.toLowerCase()}`, JSON.stringify(fresh), {
    expirationTtl: SNAPSHOT_RETENTION_SECONDS,
  });
}

async function buildSnapshot(owner, repo, env = {}) {
  const metadataUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const metadataResponse = await fetchWithTimeout(metadataUrl, {
    headers: githubHeaders(env),
  }, UPSTREAM_TIMEOUT_MS);
  if (metadataResponse.status === 404) throw new Error('Repository not found or is not public.');
  if (!metadataResponse.ok) throw new Error(`GitHub repository API returned ${metadataResponse.status}.`);
  const metadata = await metadataResponse.json();
  if (metadata.private) return { schemaVersion: SCHEMA_VERSION, owner, repo, metadata, branch: metadata.default_branch || 'HEAD', tree: [], fetchedAt: new Date().toISOString() };

  const branch = metadata.default_branch || 'HEAD';
  const [cdnRoot, apiTree] = await Promise.all([
    fetchJsDelivrDirectory(owner, repo, branch).catch((error) => {
      console.warn('LiteGH jsDelivr root listing failed:', error);
      return null;
    }),
    fetchGithubTree(owner, repo, branch, env).catch((error) => {
      console.warn('LiteGH recursive Git tree request failed:', error);
      return null;
    }),
  ]);

  let tree = apiTree?.tree?.filter((item) => item?.path && ['blob', 'tree'].includes(item.type)).slice(0, MAX_TREE_ENTRIES) || [];
  let treeComplete = Boolean(apiTree && !apiTree.truncated && apiTree.tree?.length <= MAX_TREE_ENTRIES);
  if (tree.length && cdnRoot?.length) {
    const rootByPath = new Map(cdnRoot.map((item) => [item.path, item]));
    const treeByPath = new Map(tree.map((item) => [item.path, item]));
    tree = tree.map((item) => {
      const rootItem = rootByPath.get(item.path);
      return rootItem && item.type === 'blob' ? { ...item, size: rootItem.size || item.size || 0 } : item;
    });
    // The CDN directory listing can contain root entries omitted by a truncated recursive API response.
    for (const item of cdnRoot) {
      if (!treeByPath.has(item.path)) tree.push({ ...item, mode: item.type === 'tree' ? '040000' : '100644' });
    }
  }
  if (!tree.length && cdnRoot?.length) {
    tree = cdnRoot.map((item) => ({
      path: item.path,
      type: item.type,
      size: item.size || 0,
      sha: '',
      mode: item.type === 'tree' ? '040000' : '100644',
    }));
    treeComplete = false;
  }
  if (tree.length > MAX_TREE_ENTRIES) {
    tree = tree.slice(0, MAX_TREE_ENTRIES);
    treeComplete = false;
  }
  if (!tree.length) throw new Error('Neither jsDelivr nor GitHub returned a usable repository tree.');

  const readmePath = chooseReadmePath(tree);
  let readmeMarkdown = '';
  let readmeTruncated = false;
  if (readmePath) {
    try {
      const readmeResult = await fetchRepositoryText(owner, repo, branch, readmePath);
      readmeMarkdown = readmeResult.text;
      readmeTruncated = readmeResult.truncated;
    } catch (error) {
      console.warn(`LiteGH README fetch failed for ${owner}/${repo}:`, error);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    owner,
    repo,
    branch,
    treeSha: apiTree?.sha || '',
    treeComplete,
    metadata: {
      full_name: metadata.full_name || `${owner}/${repo}`,
      description: metadata.description || '',
      homepage: metadata.homepage || '',
      stargazers_count: Number(metadata.stargazers_count || 0),
      forks_count: Number(metadata.forks_count || 0),
      subscribers_count: Number(metadata.subscribers_count ?? metadata.watchers_count ?? 0),
      language: metadata.language || '',
      license: metadata.license ? { spdx_id: metadata.license.spdx_id || '', name: metadata.license.name || '' } : null,
      archived: Boolean(metadata.archived),
      private: Boolean(metadata.private),
      fork: Boolean(metadata.fork),
      parent: metadata.parent ? { full_name: metadata.parent.full_name || '', html_url: metadata.parent.html_url || '' } : null,
      default_branch: branch,
      pushed_at: metadata.pushed_at || '',
      html_url: metadata.html_url || `https://github.com/${owner}/${repo}`,
    },
    tree,
    readmePath,
    readmeMarkdown,
    readmeTruncated,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchGithubTree(owner, repo, branch, env = {}) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const { response, text, truncated } = await fetchTextLimitedWithTimeout(
    url, { headers: githubHeaders(env) }, UPSTREAM_TIMEOUT_MS, MAX_TREE_RESPONSE_BYTES,
  );
  if (!response.ok) throw new Error(`GitHub tree API returned ${response.status}.`);
  if (truncated) throw new Error(`GitHub tree response exceeded ${MAX_TREE_RESPONSE_BYTES} bytes; using the CDN root listing instead.`);
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('GitHub returned invalid tree JSON.'); }
  if (!Array.isArray(data.tree)) throw new Error('GitHub returned an invalid tree.');
  return data;
}

function githubHeaders(env = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'LiteGH-SSR/1.0 (+https://litegh.com)',
  };
  // Optional Worker secret increases GitHub API quota without exposing a token to visitors.
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchJsDelivrDirectory(owner, repo, branch) {
  const url = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}@${encodeURIComponent(branch)}/`;
  const { response, text: html, truncated } = await fetchTextLimitedWithTimeout(
    url, { headers: { Accept: 'text/html' } }, UPSTREAM_TIMEOUT_MS, MAX_CDN_LISTING_BYTES,
  );
  if (!response.ok) throw new Error(`jsDelivr directory returned ${response.status}.`);
  if (truncated) throw new Error(`jsDelivr listing exceeded ${MAX_CDN_LISTING_BYTES} bytes.`);
  return parseJsDelivrListing(html, url);
}

function parseJsDelivrListing(html, baseUrl) {
  const basePath = new URL(baseUrl).pathname;
  const results = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html))) {
    const row = rowMatch[0];
    const nameCell = row.match(/<td\b[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/td>/i);
    if (!nameCell) continue;
    let href = decodeHtmlEntities(nameCell[1]);
    if (href.startsWith('#') || /^javascript:/i.test(href)) continue;
    let parsed;
    try { parsed = new URL(href, baseUrl); } catch (_) { continue; }
    if (parsed.origin !== 'https://cdn.jsdelivr.net' || !parsed.pathname.startsWith(basePath)) continue;
    const relative = parsed.pathname.slice(basePath.length);
    const segments = relative.split('/').filter(Boolean);
    if (segments.length !== 1) continue;
    let name;
    try { name = decodeURIComponent(segments[0]); } catch (_) { name = segments[0]; }
    if (!name || name === '.' || name === '..' || seen.has(name)) continue;
    seen.add(name);
    const isDirectory = /\/$/.test(href) || /\/$/.test(parsed.pathname) || /\bclass=["'][^"']*directory/i.test(row);
    const sizeMatch = row.match(/<td\b[^>]*class=["'][^"']*\bsize\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
    results.push({ path: name, type: isDirectory ? 'tree' : 'blob', size: isDirectory ? 0 : parseReadableSize(stripTags(sizeMatch?.[1] || '')), sha: '' });
  }
  if (!results.length) throw new Error('No entries parsed from jsDelivr directory listing.');
  return results;
}

function parseReadableSize(value) {
  const match = String(value || '').trim().match(/^([\d,]+(?:\.\d+)?)\s*(B|bytes?|KB|MB|GB|TB)?$/i);
  if (!match) return 0;
  const amount = Number(match[1].replace(/,/g, ''));
  const powers = { B: 0, BYTE: 0, BYTES: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return Math.round(amount * (1024 ** (powers[(match[2] || 'B').toUpperCase()] ?? 0)));
}

async function fetchRepositoryText(owner, repo, branch, path) {
  const cdn = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}@${encodeURIComponent(branch)}/${encodePath(path)}`;
  const raw = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodePath(path)}`;
  let lastError;
  for (const url of [cdn, raw]) {
    try {
      const { response, text, truncated } = await fetchTextLimitedWithTimeout(
        url, { headers: { Accept: 'text/plain,*/*' } }, UPSTREAM_TIMEOUT_MS, MAX_README_BYTES,
      );
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return { text, truncated };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to fetch README source.');
}

async function fetchWithTimeout(input, init = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const abortParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', abortParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Upstream request timed out.')), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    // Small JSON metadata responses are fully read while the timeout remains active.
    const body = await response.arrayBuffer();
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    if (controller.signal.aborted && !parentSignal?.aborted) throw new Error(`Upstream request timed out after ${timeoutMs} ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortParent);
  }
}

async function fetchTextLimitedWithTimeout(input, init = {}, timeoutMs = UPSTREAM_TIMEOUT_MS, maxBytes = MAX_README_BYTES) {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const abortParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', abortParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Upstream request timed out.')), timeoutMs);
  let reader;
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.body) return { response, text: '', truncated: false };
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        total += Math.max(0, remaining);
        truncated = true;
        try { await reader.cancel(); } catch (_) {}
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { response, text: new TextDecoder().decode(bytes), truncated };
  } catch (error) {
    if (controller.signal.aborted && !parentSignal?.aborted) throw new Error(`Upstream request timed out after ${timeoutMs} ms.`);
    throw error;
  } finally {
    try { reader?.releaseLock(); } catch (_) {}
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortParent);
  }
}

function chooseReadmePath(tree) {
  const files = tree.filter((item) => item.type === 'blob' && !String(item.path).includes('/'));
  const preferred = files.find((item) => /^README\.md$/i.test(item.path));
  return (preferred || files.find((item) => /^README(?:\.|$)/i.test(item.path)) || {}).path || '';
}

async function renderHtmlResponse(snapshot, route, request, env, cacheStatus) {
  const base = await getShellHtml(request, env);
  if (!base) return new Response('LiteGH static shell is unavailable. Configure the ASSETS binding.', { status: 500 });
  const path = `/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`;
  const markdownUrl = `${path}?format=markdown`;
  const json = safeJsonForHtml(snapshot);
  const treeHtml = renderTreeMarkup(snapshot, route);
  const summaryHtml = renderRepoSummary(snapshot);
  const readmeHtml = snapshot.readmePath
    ? `<article class="markdown-body ssr-markdown-body" data-ssr-readme="${escapeHtml(snapshot.readmePath)}">${renderMarkdownToHtml(snapshot.readmeMarkdown || '', snapshot, route, snapshot.readmePath)}</article>${snapshot.readmeTruncated ? '<div class="notice" role="status">This README preview is limited to 128 KiB on the server. LiteGH will try to load the complete file in the browser.</div>' : ''}`
    : `<div class="notice" role="status">No README was found in the default branch. Choose a file from the tree to view it.</div>`;

  let html = base;
  html = html.replace('<!--LITEGH_SSR_BOOTSTRAP-->', `<script>window.__LITEGH_SSR__=${json};</script>`);
  html = html.replace('<title>LiteGH</title>', `<title>${escapeHtml(snapshot.owner)} / ${escapeHtml(snapshot.repo)} · LiteGH</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeHtml(snapshot.metadata.description || `Browse ${snapshot.owner}/${snapshot.repo} on LiteGH.`)}">`);
  html = html.replace('</head>', `<link rel="alternate" type="text/markdown" href="${escapeHtml(markdownUrl)}">\n</head>`);
  html = html.replace(/<div id="repoSummary" class="repo-summary" hidden><\/div>/, `<div id="repoSummary" class="repo-summary">${summaryHtml}</div>`);
  html = html.replace(/<div id="branchControl" class="branch-control" hidden>/, '<div id="branchControl" class="branch-control">');
  html = html.replace(/<span id="branchLabel" class="branch-button-label"><\/span>/, `<span id="branchLabel" class="branch-button-label">${escapeHtml(snapshot.branch)}</span>`);
  html = html.replace(/<div id="codeControl" class="code-control" hidden>/, '<div id="codeControl" class="code-control">');
  html = html.replace(/<div id="fileCount" class="file-count">—<\/div>/, `<div id="fileCount" class="file-count" title="Server-rendered tree">${countTreeFiles(snapshot.tree)} files</div>`);
  html = html.replace(/<div id="tree" class="tree" tabindex="0"><\/div>/, `<div id="tree" class="tree" tabindex="0">${treeHtml}</div>`);
  html = html.replace(/<div id="breadcrumbs" class="breadcrumbs"><span class="crumb-file"><\/span><\/div>/, `<div id="breadcrumbs" class="breadcrumbs"><a href="${escapeHtml(path)}">${escapeHtml(snapshot.owner)} / ${escapeHtml(snapshot.repo)}</a><span>/</span><span class="crumb-file">${escapeHtml(snapshot.readmePath || 'README')}</span></div>`);
  html = html.replace(/<div id="contentBody" class="content-body">[\s\S]*?<\/div>\s*<footer class="app-footer">/, `<div id="contentBody" class="content-body">${readmeHtml}</div>\n          <footer class="app-footer">`);
  html = html.replace('</body>', `<script>document.documentElement.dataset.liteghSsr="1";</script>\n</body>`);

  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': `public, max-age=${EDGE_TTL_SECONDS}, s-maxage=${EDGE_TTL_SECONDS}`,
    'Vary': 'Accept',
    'Link': `<${markdownUrl}>; rel="alternate"; type="text/markdown"`,
    'X-LiteGH-SSR-Cache': cacheStatus,
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(html, { status: 200, headers });
}

async function getShellHtml(request, env) {
  if (!env.ASSETS) return '';
  let response = await env.ASSETS.fetch(new Request(new URL('/', request.url), { method: 'GET', headers: request.headers }));
  if (!response.ok) response = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), { method: 'GET' }));
  if (!response.ok) return '';
  return response.text();
}

function renderMarkdownResponse(snapshot, route, cacheStatus) {
  const files = snapshot.tree.slice().sort((a, b) => a.path.localeCompare(b.path));
  const treeText = files.map((item) => {
    const path = String(item.path);
    const label = item.type === 'tree' ? `${path}/` : path;
    const href = item.type === 'tree' ? liteRoute(route, snapshot.branch, path, true) : liteRoute(route, snapshot.branch, path, false);
    const size = item.type === 'blob' ? ` (${formatBytes(item.size || 0)})` : '';
    return `- [${label.replace(/\]/g, '\\]')}](${href})${size}`;
  }).join('\n');
  const readme = snapshot.readmeMarkdown ? `\n\n## ${snapshot.readmePath}\n\n${snapshot.readmeMarkdown}${snapshot.readmeTruncated ? '\n\n> Note: this cached README is truncated to 128 KiB. Open the README file URL to retrieve the full source.' : ''}` : '\n\n_No README found in the default branch._';
  const markdown = [
    `# ${snapshot.owner}/${snapshot.repo}`,
    '',
    snapshot.metadata.description || '',
    '',
    `- Repository: ${snapshot.metadata.html_url || `https://github.com/${snapshot.owner}/${snapshot.repo}`}`,
    `- Default branch: ${snapshot.branch}`,
    `- License: ${snapshot.metadata.license?.spdx_id || snapshot.metadata.license?.name || 'Not specified'}`,
    `- Archived: ${snapshot.metadata.archived ? 'yes' : 'no'}`,
    `- Stars: ${Number(snapshot.metadata.stargazers_count || 0).toLocaleString('en-US')}`,
    `- Last pushed: ${snapshot.metadata.pushed_at || 'unknown'}`,
    '',
    '## File tree',
    '',
    treeText || '_No file tree available._',
    snapshot.treeComplete ? '' : '_Note: the server-side tree index is partial; browse the HTML tree for folders loaded on demand._',
    readme,
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
  return new Response(markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': `public, max-age=${EDGE_TTL_SECONDS}, s-maxage=${EDGE_TTL_SECONDS}`,
      'Vary': 'Accept',
      'Link': `<${liteRoute(route, snapshot.branch, '', false)}>; rel="alternate"; type="text/html"`,
      'X-LiteGH-SSR-Cache': cacheStatus,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function renderRepoSummary(snapshot) {
  const m = snapshot.metadata;
  const ownerRepo = `${snapshot.owner}/${snapshot.repo}`;
  const homepage = safeHttpUrl(m.homepage);
  const pushedDate = m.pushed_at ? relativeDate(m.pushed_at) : '';
  const fork = m.fork && m.parent?.full_name
    ? `<div class="repo-summary-fork"><svg class="ui-icon" aria-hidden="true"><use href="#i-fork"></use></svg><span>forked from </span><a href="${escapeHtml(m.parent.html_url || `https://github.com/${m.parent.full_name}`)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.parent.full_name)}</a></div>`
    : '';
  const homepageLink = homepage ? `<a href="${escapeHtml(homepage)}" target="_blank" rel="noopener noreferrer" title="Project homepage"><svg class="ui-icon" aria-hidden="true"><use href="#i-link"></use></svg><span>Home</span></a>` : '';
  return `<div class="repo-summary-name"><svg class="ui-icon" aria-hidden="true"><use href="#i-github"></use></svg><a href="https://github.com/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(snapshot.repo)}/" target="_blank" rel="noopener noreferrer" title="Open repository on GitHub">${escapeHtml(ownerRepo)}</a>${m.private ? '<svg class="ui-icon" aria-label="Private repository"><use href="#i-lock"></use></svg>' : ''}</div>${fork}${m.description ? `<p class="repo-summary-description">${escapeHtml(m.description)}</p>` : ''}<div class="repo-summary-meta"><span class="repo-summary-stat" title="Stars"><svg class="ui-icon" aria-hidden="true"><use href="#i-star"></use></svg>${Number(m.stargazers_count || 0).toLocaleString('en-US')}</span><span class="repo-summary-stat" title="Forks"><svg class="ui-icon" aria-hidden="true"><use href="#i-fork"></use></svg>${Number(m.forks_count || 0).toLocaleString('en-US')}</span><span class="repo-summary-stat" title="Watchers"><svg class="ui-icon" aria-hidden="true"><use href="#i-eye"></use></svg>${Number(m.subscribers_count || 0).toLocaleString('en-US')}</span>${pushedDate ? `<span class="repo-summary-stat" title="${escapeHtml(m.pushed_at)}"><svg class="ui-icon" aria-hidden="true"><use href="#i-clock"></use></svg>${escapeHtml(pushedDate)}</span>` : ''}${m.language ? `<span class="repo-summary-stat" title="Main language"><svg class="ui-icon" aria-hidden="true"><use href="#i-language"></use></svg>${escapeHtml(m.language)}</span>` : ''}${m.license?.spdx_id ? `<span class="repo-summary-stat" title="License"><svg class="ui-icon" aria-hidden="true"><use href="#i-file"></use></svg>${escapeHtml(m.license.spdx_id)}</span>` : ''}${m.archived ? '<span class="repo-summary-stat" title="This repository is archived and read-only"><svg class="ui-icon" aria-hidden="true"><use href="#i-archive"></use></svg>Archived</span>' : ''}${homepageLink}</div>`;
}

function renderTreeMarkup(snapshot, route) {
  const root = new Map();
  for (const item of snapshot.tree) {
    if (!item?.path || !['blob', 'tree'].includes(item.type)) continue;
    const parts = item.path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let map = root;
    let pathSoFar = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${name}` : name;
      let node = map.get(name);
      const type = i === parts.length - 1 ? item.type : 'tree';
      if (!node) {
        node = { name, path: pathSoFar, type, size: type === 'blob' ? Number(item.size || 0) : 0, sha: item.sha || '', children: new Map() };
        map.set(name, node);
      } else if (i === parts.length - 1) {
        node.type = type;
        node.size = Number(item.size || node.size || 0);
        node.sha = item.sha || node.sha;
      }
      map = node.children;
    }
  }
  if (snapshot.tree.length && !snapshot.treeComplete) {
    // If only a root listing is available, map remains flat and still gives a useful SSR tree.
  }
  const renderNodes = (map, depth) => [...map.values()].sort((a, b) => a.type !== b.type ? (a.type === 'tree' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map((node) => {
    if (node.type === 'tree') {
      const children = renderNodes(node.children, depth + 1);
      const href = liteRoute(route, snapshot.branch, node.path, true);
      return `<details class="folder-wrap" data-folder-path="${escapeHtml(node.path)}"><summary class="tree-folder tree-indent-${Math.min(depth, 4)}" title="${escapeHtml(node.path)}"><svg class="ui-icon tree-folder-icon" aria-hidden="true"><use href="#i-folder"></use></svg><span class="tree-name">${escapeHtml(node.name)}</span><a class="ssr-folder-link" href="${escapeHtml(href)}" aria-label="Browse folder ${escapeHtml(node.path)}">↗</a></summary><div class="folder-children">${children || '<div class="folder-placeholder">Empty folder</div>'}</div></details>`;
    }
    const href = liteRoute(route, snapshot.branch, node.path, false);
    const [icon, kind] = fileIcon(node.name);
    return `<a class="tree-item tree-indent-${Math.min(depth, 4)} ssr-tree-link" href="${escapeHtml(href)}" role="link" data-action="select-file" data-path="${escapeHtml(node.path)}" title="${escapeHtml(`${node.path}\n${formatBytes(node.size)}`)}"><span class="tree-item-main"><svg class="ui-icon tree-icon file-kind ${kind}" aria-hidden="true"><use href="#${icon}"></use></svg><span class="tree-name">${escapeHtml(node.name)}</span></span><span class="tree-size">${escapeHtml(formatBytes(node.size))}</span></a>`;
  }).join('');
  return renderNodes(root, 0) || '<div class="notice">No visible files in this repository.</div>';
}

function renderMarkdownToHtml(markdown, snapshot, route, filePath) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null;
  let fence = null;
  let code = [];
  let quote = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${renderInline(paragraph.join('\n'), snapshot, route, filePath)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.type === 'ol' ? 'ol' : 'ul';
    out.push(`<${tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${renderInline(quote.join('\n'), snapshot, route, filePath)}</p></blockquote>`);
    quote = [];
  };
  const isBlockStart = (line) => /^\s*(```|~~~|#{1,6}\s|>\s?|[-*+]\s+|\d+\.\s+|---+\s*$|\*\*\*+\s*$)/.test(line);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fenceMatch = line.match(/^\s*(```+|~~~+)([^`]*)$/);
    if (fenceMatch) {
      flushParagraph(); flushList(); flushQuote();
      if (!fence) { fence = fenceMatch[1].slice(0, 3); code = []; }
      else { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); fence = null; code = []; }
      continue;
    }
    if (fence) { code.push(line); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph(); flushList(); flushQuote();
      const level = heading[1].length;
      const title = heading[2];
      out.push(`<h${level} id="${escapeHtml(slugifyServer(title))}">${renderInline(title, snapshot, route, filePath)}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { flushParagraph(); flushList(); flushQuote(); out.push('<hr>'); continue; }
    const quoteLine = line.match(/^\s*>\s?(.*)$/);
    if (quoteLine) { flushParagraph(); flushList(); quote.push(quoteLine[1]); continue; }
    if (!quoteLine) flushQuote();
    if (!line.trim()) { flushParagraph(); flushList(); flushQuote(); continue; }
    const nextLine = lines[lineIndex + 1] || '';
    const isTable = line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine);
    if (isTable) {
      flushParagraph(); flushList(); flushQuote();
      const splitCells = (value) => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      const headers = splitCells(line);
      const alignments = splitCells(nextLine).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
      const tableRows = [];
      lineIndex += 2;
      while (lineIndex < lines.length && lines[lineIndex].includes('|') && lines[lineIndex].trim()) {
        tableRows.push(splitCells(lines[lineIndex]));
        lineIndex += 1;
      }
      lineIndex -= 1;
      const th = headers.map((cell, index) => `<th${alignments[index] ? ` class=\"align-${alignments[index]}\"` : ''}>${renderInline(cell, snapshot, route, filePath)}</th>`).join('');
      const tbody = tableRows.map((cells) => `<tr>${headers.map((_, index) => {
        const align = alignments[index];
        return `<td${align ? ` class=\"align-${align}\"` : ''}>${renderInline(cells[index] || '', snapshot, route, filePath)}</td>`;
      }).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tbody}</tbody></table>`);
      continue;
    }
    const listMatch = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);
    if (listMatch) {
      flushParagraph(); flushQuote();
      const nextList = listMatch[2] ? 'ol' : 'ul';
      if (list && list.type !== nextList) flushList();
      if (!list) list = { type: nextList, items: [] };
      let content = listMatch[3];
      const task = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) content = `<input type="checkbox" disabled${task[1].trim() ? ' checked' : ''}> ${renderInline(task[2], snapshot, route, filePath)}`;
      else content = renderInline(content, snapshot, route, filePath);
      list.items.push(content);
      continue;
    }
    if (list) flushList();
    if (isBlockStart(line)) { flushParagraph(); flushList(); }
    paragraph.push(line);
  }
  flushParagraph(); flushList(); flushQuote();
  if (fence) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return out.join('\n');
}

function renderInline(source, snapshot, route, filePath) {
  const tokens = [];
  let text = String(source || '');
  const stash = (html) => {
    const token = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return token;
  };
  text = text.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/!\[([^\]]*)\]\((\S+?)(?:\s+["'](.*?)["'])?\)/g, (_, alt, rawUrl, title = '') => {
    const url = resolveMarkdownUrl(rawUrl, snapshot, route, filePath, true);
    if (!url) return stash(escapeHtml(alt));
    const fallback = rawUrl.startsWith('http:') || rawUrl.startsWith('https:') || rawUrl.startsWith('//') ? '' : rawUrlUrl(snapshot, filePath, rawUrl);
    return stash(`<img src="${escapeHtml(url)}"${fallback ? ` data-fallback-src="${escapeHtml(fallback)}"` : ''} alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`);
  });
  text = text.replace(/\[([^\]]+)\]\((\S+?)(?:\s+["'](.*?)["'])?\)/g, (_, label, rawUrl, title = '') => {
    const url = resolveMarkdownUrl(rawUrl, snapshot, route, filePath, false);
    if (!url) return stash(escapeHtml(label));
    const localPath = getRelativeRepoPath(rawUrl, filePath);
    const dataPath = localPath && !/^(?:https?:)?\/\//i.test(rawUrl) && !/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? ` data-repo-path="${escapeHtml(localPath)}"` : '';
    const isExternal = /^https?:\/\//i.test(url) || url.startsWith('//');
    return stash(`<a href="${escapeHtml(url)}"${dataPath}${isExternal ? ' target="_blank" rel="noopener noreferrer"' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</a>`);
  });
  text = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/ {2}\n/g, '<br>\n')
    .replace(/\n/g, '\n');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
}

function resolveMarkdownUrl(rawUrl, snapshot, route, filePath, isImage) {
  const raw = String(rawUrl || '').trim();
  if (!raw || /^javascript:/i.test(raw) || /^data:/i.test(raw)) return '';
  if (/^(?:https?:)?\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return /^(?:https?:|mailto:|tel:)/i.test(raw) ? raw : '';
  if (raw.startsWith('#')) return raw;
  const path = getRelativeRepoPath(raw, filePath);
  if (!path) return '';
  if (isImage) return `https://cdn.jsdelivr.net/gh/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(snapshot.repo)}@${encodeURIComponent(snapshot.branch)}/${encodePath(path)}`;
  const target = snapshot.tree.find((item) => item.path === path);
  if (target?.type === 'tree' || raw.endsWith('/')) return liteRoute(route, snapshot.branch, path, true);
  const [clean, hash] = raw.split('#', 2);
  const routeUrl = liteRoute(route, snapshot.branch, path, false);
  return hash ? `${routeUrl}#${encodeURIComponent(hash)}` : routeUrl;
}

function rawUrlUrl(snapshot, currentPath, rawUrl) {
  const path = getRelativeRepoPath(rawUrl, currentPath);
  return path ? `https://raw.githubusercontent.com/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(snapshot.repo)}/${encodeURIComponent(snapshot.branch)}/${encodePath(path)}` : '';
}

function getRelativeRepoPath(rawUrl, currentPath) {
  const clean = String(rawUrl || '').split(/[?#]/, 1)[0];
  if (!clean || clean.startsWith('#') || /^(?:https?:)?\/\//i.test(clean) || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return '';
  const stack = clean.startsWith('/') ? [] : currentPath.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(safeDecode(part));
  }
  return stack.join('/');
}

function liteRoute(route, branch, filePath, isFolder = false) {
  const base = `/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`;
  if (!filePath) return base;
  return `${base}/${isFolder ? 'tree' : 'blob'}/${encodeURIComponent(branch)}/${encodePath(filePath)}${isFolder ? '/' : ''}`;
}

function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const map = {
    md: ['i-markdown', 'kind-markdown'], mdx: ['i-markdown', 'kind-markdown'],
    js: ['i-js', 'kind-js'], mjs: ['i-js', 'kind-js'], cjs: ['i-js', 'kind-js'],
    ts: ['i-js', 'kind-ts'], tsx: ['i-js', 'kind-ts'], jsx: ['i-js', 'kind-js'],
    json: ['i-json', 'kind-json'], html: ['i-html', 'kind-html'], htm: ['i-html', 'kind-html'], css: ['i-css', 'kind-css'],
    py: ['i-python', 'kind-python'], sh: ['i-shell', 'kind-shell'], yml: ['i-file', 'kind-data'], yaml: ['i-file', 'kind-data'],
    png: ['i-image', 'kind-image'], jpg: ['i-image', 'kind-image'], jpeg: ['i-image', 'kind-image'], gif: ['i-image', 'kind-image'], webp: ['i-image', 'kind-image'], svg: ['i-image', 'kind-image'],
    mp3: ['i-audio', 'kind-audio'], wav: ['i-audio', 'kind-audio'], mp4: ['i-video', 'kind-video'], webm: ['i-video', 'kind-video'], pdf: ['i-pdf', 'kind-pdf'], zip: ['i-archive', 'kind-archive'],
  };
  return map[ext] || ['i-file', ''];
}

function countTreeFiles(tree) {
  return tree.filter((item) => item.type === 'blob').length;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size < 10 ? size.toFixed(2) : size < 100 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function relativeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  if (abs < minute) return `${Math.round(diff / 1000)}s`;
  if (abs < hour) return `${Math.round(diff / minute)}m`;
  if (abs < day) return `${Math.round(diff / hour)}h`;
  if (abs < 30 * day) return `${Math.round(diff / day)}d`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function slugifyServer(text) {
  return String(text).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-') || 'section';
}

function safeHttpUrl(value) {
  try { const url = new URL(String(value || '').trim()); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; }
}

function safeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function encodePath(value) {
  return String(value || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
