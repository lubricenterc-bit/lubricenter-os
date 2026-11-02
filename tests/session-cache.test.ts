import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
let authListener: ((event: string) => void) | undefined;
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { onAuthStateChange: (cb: (event: string) => void) => { authListener = cb; return { data: { subscription: { unsubscribe() {} } } }; } },
  },
}));

const { cachedRpc, clearSessionCache } = await import('../lib/session-cache');

describe('session cache for identity RPCs', () => {
  beforeEach(() => {
    rpc.mockReset();
    clearSessionCache();
    vi.stubGlobal('window', {});
  });

  it('collapses concurrent callers into one network request', async () => {
    rpc.mockResolvedValue({ data: 'OWNER', error: null });
    const [a, b, c] = await Promise.all([cachedRpc('finance_role'), cachedRpc('finance_role'), cachedRpc('finance_role')]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect([a.data, b.data, c.data]).toEqual(['OWNER', 'OWNER', 'OWNER']);
  });

  it('never caches an error, so the next call retries', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'red caída' } })
       .mockResolvedValueOnce({ data: true, error: null });
    expect((await cachedRpc('can_administer_orders')).error?.message).toBe('red caída');
    expect((await cachedRpc('can_administer_orders')).data).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('turns a thrown network failure into an error result instead of rejecting', async () => {
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'));
    const r = await cachedRpc('finance_role');
    expect(r).toEqual({ data: null, error: { message: 'Failed to fetch' } });
  });

  it('expires after the TTL and is cleared when the user signs out', async () => {
    rpc.mockResolvedValue({ data: 'ADMIN', error: null });
    await cachedRpc('finance_role', 10_000);
    await cachedRpc('finance_role', 10_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    authListener?.('SIGNED_OUT');
    await cachedRpc('finance_role', 10_000);
    expect(rpc).toHaveBeenCalledTimes(2);
    await cachedRpc('finance_role', 0);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
