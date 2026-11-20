// Publer (social scheduler) recent-posts snapshot, cached by the worker.
// Cleaned up from a recovered esbuild bundle; behavior is unchanged from the original.

const BASE = 'https://app.publer.com/api/v1';

export async function publerSnapshot(env) {
  if (!env.PUBLER_API_KEY) return { connected: false };
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const qs = new URLSearchParams({ state: 'published', from, limit: '100' });
    const r = await fetch(`${BASE}/posts?${qs}`, {
      headers: { Authorization: `Bearer-API ${env.PUBLER_API_KEY}`, 'Publer-Workspace-Id': env.PUBLER_WORKSPACE_ID || '', Accept: 'application/json' },
    });
    if (!r.ok) return { connected: true, error: `publer ${r.status}` };
    const data = await r.json();
    const raw = Array.isArray(data) ? data : data.posts || data.data || [];
    const posts = raw.slice(0, 100).map((p) => ({
      id: String(p.id || ''),
      network: String(p.network || p.provider || (p.account && p.account.provider) || ''),
      text: String(p.text || p.title || '').slice(0, 140),
      url: String(p.post_link || p.url || ''),
      at: p.published_at || p.scheduled_at || null,
      stats: p.analytics || p.insights || null,
    }));
    return { connected: true, verified: false, fetchedAt: new Date().toISOString(), posts };
  } catch (e) {
    console.error('publer snapshot', String(e));
    return { connected: true, error: 'publer' };
  }
}
