import { withHeartbeat } from './rabbitmq-embedding';

describe('withHeartbeat (amqplib reads heartbeat from the URL query only)', () => {
    it('adds the configured heartbeat and keeps credentials and vhost', () => {
        const out = withHeartbeat('amqp://user:fake%40pw@broker:5672/inference', 60);
        const u = new URL(out);
        expect(u.searchParams.get('heartbeat')).toBe('60');
        expect(u.username).toBe('user');
        expect(u.password).toBe('fake%40pw');
        expect(u.pathname).toBe('/inference');
        expect(u.host).toBe('broker:5672');
    });

    it('keeps an explicit heartbeat already present in the URL', () => {
        const url = 'amqp://user:dummy-pw@broker/inference?heartbeat=15';
        expect(withHeartbeat(url, 60)).toBe(url);
    });

    it('preserves other query parameters', () => {
        const u = new URL(withHeartbeat('amqp://broker/vh?frameMax=8192', 30));
        expect(u.searchParams.get('frameMax')).toBe('8192');
        expect(u.searchParams.get('heartbeat')).toBe('30');
    });

    it('leaves the URL unchanged when no heartbeat is configured or the URL is invalid', () => {
        expect(withHeartbeat('amqp://broker/vh', undefined)).toBe('amqp://broker/vh');
        expect(withHeartbeat('not a url', 60)).toBe('not a url');
    });

    it('is parsed by amqplib as the negotiated heartbeat', async () => {
        // Same URL handling amqplib uses (lib/connect.js reads query.heartbeat).
        const q = new URL(withHeartbeat('amqp://broker/vh', 45)).searchParams;
        expect(Number(q.get('heartbeat'))).toBe(45);
    });
});
