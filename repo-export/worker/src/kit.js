// Kit (ConvertKit) subscriber/broadcast snapshot, cached by the worker.
// Cleaned up from a recovered esbuild bundle; behavior is unchanged from the original.

const BASE = 'https://api.kit.com/v4';

export async function kitSnapshot(env) {
  if (!env.KIT_API_KEY) return { connected: false };
  const get = async (path) => {
    const r = await fetch(BASE + path, { headers: { 'X-Kit-Api-Key': env.KIT_API_KEY, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Kit ${path} -> ${r.status}`);
    return r.json();
  };
  try {
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const days = {};
    let after = null, pages = 0, total = null;
    do {
      const qs = new URLSearchParams({ per_page: '1000', created_after: since, include_total_count: 'true' });
      if (after) qs.set('after', after);
      const page = await get(`/subscribers?${qs}`);
      if (total === null && page.pagination) total = page.pagination.total_count ?? null;
      for (const s of page.subscribers || []) {
        const d = String(s.created_at || '').slice(0, 10);
        if (d) days[d] = (days[d] || 0) + 1;
      }
      after = page.pagination && page.pagination.has_next_page ? page.pagination.end_cursor : null;
      pages += 1;
    } while (after && pages < 10);
    let allTime = null;
    try {
      const t = await get('/subscribers?per_page=1&include_total_count=true');
      allTime = t.pagination ? t.pagination.total_count ?? null : null;
    } catch (_) {
      // all-time count is a nice-to-have
    }
    const list = await get('/broadcasts?per_page=50');
    const sent = (list.broadcasts || [])
      .filter((b) => b.published_at || b.send_at)
      .sort((a, b) => String(b.send_at || b.published_at).localeCompare(String(a.send_at || a.published_at)))
      .slice(0, 15);
    const broadcasts = [];
    for (const b of sent) {
      let stats = {};
      try {
        stats = ((await get(`/broadcasts/${b.id}/stats`)).broadcast || {}).stats || {};
      } catch (_) {
        // a single broadcast's stats failing shouldn't drop the rest
      }
      broadcasts.push({
        id: b.id,
        subject: b.subject || '',
        sentAt: b.send_at || b.published_at,
        recipients: stats.recipients ?? null,
        openRate: stats.open_rate ?? null,
        clickRate: stats.click_rate ?? null,
        clicks: stats.total_clicks ?? null,
        unsubscribes: stats.unsubscribes ?? null,
      });
    }
    return { connected: true, fetchedAt: new Date().toISOString(), allTime, recentTotal: total, daily: days, partial: pages >= 10, broadcasts };
  } catch (e) {
    console.error('kit snapshot', String(e));
    return { connected: true, error: 'kit' };
  }
}
